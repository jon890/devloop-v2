import {
  NON_PROJECT_REFERENCE_KEYS,
  TASK_REFERENCE_PATH_PREFIX,
  TASK_REFERENCE_PATTERN,
  TASK_REFERENCE_TOKEN_BOUNDARY,
  TASK_REFERENCE_URL_MARK,
  TASK_REFERENCE_VERSION_SUFFIX,
} from "./structural-extractor.const";

export interface TaskReference {
  project: string;
  number: string;
}

/** 매치를 감싸는 공백 없는 토큰을 잘라낸다. URL·경로 여부는 매치 자체가 아니라 이 토큰으로 판정해야 한다. */
function enclosingToken(text: string, index: number): string {
  let start = index;
  while (start > 0 && !TASK_REFERENCE_TOKEN_BOUNDARY.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !TASK_REFERENCE_TOKEN_BOUNDARY.test(text[end])) end += 1;
  return text.slice(start, end);
}

/**
 * `프로젝트/번호` 매치 중 실제 Dooray 업무 참조만 남긴다.
 *
 * `단어/숫자` 를 전부 참조로 보면 URL 조각(`github.com/.../pull/52`)·파일 경로(`./images/16.jpg`)·
 * 날짜(`7/14`)·버전(`Java/11.0.6`)까지 REFERENCES 관계가 되어 존재하지 않는 업무 번호를 답에 섞는다.
 * 자기 번호를 본문에 적는 것도 참조가 아니므로 제외한다.
 *
 * `project` 는 지금 추출 중인 프로젝트다. Task 노드 키가 번호뿐이라 `CV-OCR/78` 로 관계를 만들면
 * CV-OCR 의 78번이 아니라 이 프로젝트의 78번을 가리키게 되므로, 다른 프로젝트 참조는 관계로 만들지 않는다.
 * 비교는 대소문자를 무시한다 — 추출 대상 프로젝트는 CLI 인자로 사람이 입력하므로 표기가 흔들릴 수 있다.
 */
export function findTaskReferences(text: string, sourceKey: string, project: string): TaskReference[] {
  const target = project.toLowerCase();
  const references: TaskReference[] = [];
  for (const match of text.matchAll(TASK_REFERENCE_PATTERN)) {
    const [matched, referenceProject, number] = match;
    if (!/[A-Za-z]/.test(referenceProject)) continue;
    if (NON_PROJECT_REFERENCE_KEYS.has(referenceProject.toLowerCase())) continue;
    if (TASK_REFERENCE_VERSION_SUFFIX.test(text.slice(match.index + matched.length))) continue;
    const token = enclosingToken(text, match.index);
    if (token.includes(TASK_REFERENCE_URL_MARK)) continue;
    if (TASK_REFERENCE_PATH_PREFIX.test(token)) continue;
    if (referenceProject.toLowerCase() !== target) continue;
    if (number === sourceKey) continue;
    references.push({ project: referenceProject, number });
  }
  return references;
}
