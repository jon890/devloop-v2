export const TASK_REFERENCE_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9_-]*)\/(\d+)\b/g;
/** 공백·괄호·따옴표는 토큰 경계다. 매치를 둘러싼 토큰 전체를 잘라내 URL·경로인지 판정하는 데 쓴다. */
export const TASK_REFERENCE_TOKEN_BOUNDARY = /[\s()[\]{}'"`,<>|]/;
/** 토큰이 `/`·`./`·`../` 로 시작하면 파일 경로다 (`./images/16.jpg`, `](/files/327...)`). */
export const TASK_REFERENCE_PATH_PREFIX = /^\.{0,2}\//;
/** 스킴이 있으면 URL 이다 (`https://...`, `dooray://...`). */
export const TASK_REFERENCE_URL_MARK = "://";
/** 숫자 뒤에 `.숫자` 가 이어지면 버전 문자열이다 (`Java/11.0.6`, `nginx/1.24.0`). */
export const TASK_REFERENCE_VERSION_SUFFIX = /^\.\d/;
/** 프로토콜·포맷 이름은 Dooray 프로젝트 키가 아니다 (`HTTP/2`, `HTML/404`). */
export const NON_PROJECT_REFERENCE_KEYS = new Set(["http", "https", "html"]);
export const CODE_REFERENCE_PATTERN = /\b\w+(?:Service|Controller|Interceptor|Component):\d+\b/g;
export const TAG_DIMENSION_PATTERN = /^([012]):\s*/;
