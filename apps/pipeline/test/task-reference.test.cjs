const assert = require('node:assert/strict');
const test = require('node:test');

const { findTaskReferences } = require('../dist/extract/task-reference');

function refs(text, sourceKey = '999', project = 'tc-ocr') {
  return findTaskReferences(text, sourceKey, project).map((reference) => `${reference.project}/${reference.number}`);
}

test('keeps a plain Dooray task reference', () => {
  assert.deepEqual(refs('* [tc-ocr/483 &#91;OCR&#93; 로그 정리](dooray://1387/tasks/42 "closed")'), ['tc-ocr/483']);
});

test('keeps a bare and a hash-prefixed reference in git commit text', () => {
  assert.deepEqual(refs('Merge pull request #42 from TOASTCloud/tc-ocr/100 #tc-ocr/104 multipart'), ['tc-ocr/100', 'tc-ocr/104']);
});

test('drops a cross-project reference: Task 키가 번호뿐이라 이 프로젝트의 같은 번호 업무로 이어진다', () => {
  assert.deepEqual(refs('* [CV-OCR/78 &#91;사업자 등록증 인식&#93; API 설계](dooray://1387/tasks/30)'), []);
  assert.deepEqual(refs('* [(선별)NHNCloud/195 &#91;릴리스플랜&#93; OCR'), []);
  assert.deepEqual(refs('등록한 dooray-cli/issues/54, /56 모두'), []);
});

test('compares the project key case-insensitively', () => {
  assert.deepEqual(refs('[TC-OCR/483 로그 정리](dooray://1387/tasks/42)', '999', 'tc-ocr'), ['TC-OCR/483']);
  assert.deepEqual(refs('[tc-ocr/483 로그 정리](dooray://1387/tasks/42)', '999', 'TC-OCR'), ['tc-ocr/483']);
});

test('drops a self reference', () => {
  assert.deepEqual(refs('tc-ocr/505 컨테이너 memory limit 상향', '505'), []);
});

test('drops a self reference that arrives as a git branch name', () => {
  assert.deepEqual(refs('Create Branch `refs/heads/tc-ocr/127`', '127'), []);
});

test('drops GitHub pull request and issue URLs', () => {
  assert.deepEqual(refs('PR: https://github.nhnent.com/toast-lab/repo/pull/52 참고'), []);
  assert.deepEqual(refs('[https://github.com/argoproj/argo-cd/issues/20026](https://github.com/argoproj/argo-cd/issues/20026)'), []);
});

test('drops dooray:// link targets', () => {
  assert.deepEqual(refs('[서비스 출시](dooray://1387695619080878080/tasks/2892095382697070591 "closed")'), []);
  assert.deepEqual(refs('[@진혜진](dooray://1387695619080878080/members/1879230127493697089 "member")'), []);
});

test('drops relative and absolute file paths', () => {
  assert.deepEqual(refs("{'./images/16.jpg': \"fileName: ./images/16.jpg\"}"), []);
  assert.deepEqual(refs('![image.png](/files/3275501963239792668)'), []);
});

test('drops dates, ratios and address fragments that have no letter in the project key', () => {
  assert.deepEqual(refs('개발 완료 일정은 1/6까지 완료할 예정이며 1/9에 적용'), []);
  assert.deepEqual(refs('성공한 요청: 100/100 실패한 요청: 0/100'), []);
  assert.deepEqual(refs('r124.93.209.178/32,r59.46.174.196/32'), []);
});

test('drops version strings and user agents', () => {
  assert.deepEqual(refs('User-Agent: Java/11.0.6'), []);
  assert.deepEqual(refs('Server: nginx/1.24.0'), []);
  assert.deepEqual(refs('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'), []);
});

test('drops protocol and format tokens', () => {
  assert.deepEqual(refs('HTTP/2 Rapid Reset DDoS 보안업데이트'), []);
  assert.deepEqual(refs('HTTP 200 + 표준 envelope — HTML/404/502 없음'), []);
});

test('keeps every reference in a mixed paragraph', () => {
  const text = [
    '## 내용',
    '* [tc-ocr/483 로그 정리](dooray://1387/tasks/42 "closed")',
    '* PR https://github.nhnent.com/toast-lab/repo/pull/52',
    '* 일정 7/14 ~ 7/24',
    '* [CV-OCR/121 General OCR](dooray://1387/tasks/43)',
    '* [tc-ocr/491 부하 테스트](dooray://1387/tasks/44)',
  ].join('\n');
  assert.deepEqual(refs(text), ['tc-ocr/483', 'tc-ocr/491']);
});
