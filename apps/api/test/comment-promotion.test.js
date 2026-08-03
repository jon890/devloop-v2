const assert = require('node:assert/strict');
const { test } = require('node:test');
const { dropCommentHits, promoteCommentAnchors, rankAnchorCandidates } = require('../dist/query/query.service');
const { displayFor } = require('../dist/neo4j/neo4j.service');
const { COMMENT_DISPLAY_LIMIT } = require('../dist/neo4j/neo4j.const');

function node(id, label, properties = {}) {
  return { id, label, key: id, display: id, properties };
}

const match = (id, label, score) => ({ node: node(id, label), score });

test('댓글 히트가 부모 업무로 바뀌고 순위와 점수를 물려받는다', () => {
  const matches = [match('c-1', 'Comment', 9.5), match('t-9', 'Task', 1.0)];
  const parents = new Map([['c-1', node('t-483', 'Task')]]);

  const promoted = promoteCommentAnchors(matches, parents);

  assert.equal(promoted.length, 2);
  assert.equal(promoted[0].node.id, 't-483', '댓글이 있던 1위 자리를 부모가 받는다');
  assert.equal(promoted[0].score, 9.5, '점수를 그대로 물려받는다');
  assert.equal(promoted[1].node.id, 't-9');
});

test('같은 업무의 댓글 두 건이 가장 높은 순위 하나로 합쳐진다', () => {
  const matches = [match('c-1', 'Comment', 5), match('c-2', 'Comment', 8), match('t-other', 'Task', 1)];
  const parents = new Map([
    ['c-1', node('t-483', 'Task')],
    ['c-2', node('t-483', 'Task')],
  ]);

  const promoted = promoteCommentAnchors(matches, parents);

  assert.equal(promoted.length, 2, '댓글 두 건이 한 자리로 합쳐진다');
  assert.equal(promoted[0].node.id, 't-483');
  assert.equal(promoted[0].score, 8, '합칠 때 더 높은 점수를 남긴다');
  assert.equal(promoted[1].node.id, 't-other');
});

test('승격한 업무가 이미 결과에 있으면 더 높은 순위 자리를 남긴다', () => {
  const matches = [match('t-483', 'Task', 2), match('c-1', 'Comment', 7)];
  const parents = new Map([['c-1', node('t-483', 'Task')]]);

  const promoted = promoteCommentAnchors(matches, parents);

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].node.id, 't-483');
  assert.equal(promoted[0].score, 7, '점수는 큰 값을 쓴다');
});

test('부모를 못 찾은 댓글 히트는 결과에서 사라진다', () => {
  const matches = [match('c-orphan', 'Comment', 9), match('t-1', 'Task', 1)];

  const promoted = promoteCommentAnchors(matches, new Map());

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].node.id, 't-1');
});

test('승격 결과에 Comment 라벨이 남지 않는다', () => {
  const matches = [match('c-1', 'Comment', 9), match('c-orphan', 'Comment', 8), match('w-1', 'Wiki', 2)];
  const parents = new Map([['c-1', node('t-483', 'Task')]]);

  const promoted = promoteCommentAnchors(matches, parents);

  assert.equal(
    promoted.some((entry) => entry.node.label === 'Comment'),
    false,
  );
});

test('승격된 1위 업무가 앵커 융합에서 1위 무게를 갖는다', () => {
  const parents = new Map([['c-1', node('t-483', 'Task')]]);
  const promotedSet = promoteCommentAnchors([match('c-1', 'Comment', 9.5), match('t-noise', 'Task', 9.4)], parents);

  const anchors = rankAnchorCandidates([promotedSet], 8);

  assert.equal(anchors[0].id, 't-483', '순위 승계가 융합 결과 1위로 이어진다');
});

test('댓글 히트를 최하위로 넣으면 융합 1위가 바뀐다 — 순위 승계가 결과를 가른다', () => {
  const parents = new Map([['c-1', node('t-483', 'Task')]]);
  const demoted = [{ node: node('t-noise', 'Task'), score: 9.4 }, { node: parents.get('c-1'), score: 9.5 }];

  const anchors = rankAnchorCandidates([demoted], 8);

  assert.equal(anchors[0].id, 't-noise', '최하위로 넣으면 엉뚱한 업무가 1위가 된다');
});

// 부모 조회가 실패해도 Comment 가 앵커 목록에 남으면 안 된다.
// ANCHOR_LABEL_QUOTAS 에 Comment 항목이 없어 max 가 없으므로 backfill 이 제한 없이 채운다.
test('승격이 실패하면 Comment 히트를 버리고 나머지는 남긴다', () => {
  const resultSets = [
    [match('c-1', 'Comment', 9), match('t-1', 'Task', 5)],
    [match('w-1', 'Wiki', 3), match('c-2', 'Comment', 8)],
  ];

  const dropped = dropCommentHits(resultSets);

  assert.deepEqual(
    dropped.map((set) => set.map((entry) => entry.node.id)),
    [['t-1'], ['w-1']],
  );
  assert.equal(
    dropped.flat().some((entry) => entry.node.label === 'Comment'),
    false,
    '실패 경로에서도 Comment 앵커가 남지 않는다',
  );
});

test('displayFor 는 긴 Comment 를 자르고 다른 라벨은 그대로 둔다', () => {
  const longExcerpt = '가'.repeat(6000);

  const commentDisplay = displayFor('Comment', { commentId: 'c-1', excerpt: longExcerpt }, 'c-1');

  assert.equal(commentDisplay.length, COMMENT_DISPLAY_LIMIT + 1, '상한까지 자르고 생략 기호 한 글자를 붙인다');
  assert.ok(commentDisplay.startsWith('가'.repeat(50)), '앞부분은 원문 그대로다');

  // 다른 라벨은 길어도 건드리지 않는다.
  const longSubject = '나'.repeat(6000);
  assert.equal(displayFor('Task', { subject: longSubject }, '101'), longSubject);
  assert.equal(displayFor('Wiki', { subject: longSubject }, 'w-1'), longSubject);
  assert.equal(displayFor('Concept', { name: longSubject }, 'c'), longSubject);
  assert.equal(displayFor('Decision', { summary: longSubject }, 'd-1'), longSubject);
});

test('상한 이하 Comment 는 잘리지 않는다', () => {
  const shortExcerpt = '요청 크기 상향 확인했습니다';

  assert.equal(displayFor('Comment', { commentId: 'c-2', excerpt: shortExcerpt }, 'c-2'), shortExcerpt);
});

test('Comment display 는 개행을 한 줄로 눕힌다 — 목록이 깨지지 않게 한다', () => {
  const table = ['| 레포 | 값 |', '| --- | --- |', '| cv.ocr.general_inf | 30MB |'].join('\n');

  const commentDisplay = displayFor('Comment', { commentId: 'c-3', excerpt: table }, 'c-3');

  assert.equal(commentDisplay.includes('\n'), false);
  assert.equal(commentDisplay, '| 레포 | 값 | | --- | --- | | cv.ocr.general_inf | 30MB |');
});
