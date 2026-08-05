// 응답 계약 세 개만 zod v4 로 쓴다. `toJSONSchema` 가 v4 에만 있고, 이 세 스키마는 외부 스키마를
// 참조하지 않아 계약 패키지(`@devloop/shared`, zod 3)를 함께 올릴 필요가 없다.
// v4 객체 안에 zod 3 스키마를 넣으면 `Cannot read properties of undefined (reading 'def')` 로 실패한다.
import { z } from "zod/v4";

export const AnchorResponseSchema = z.object({ terms: z.array(z.string().min(1)).min(1) });
export const CypherResponseSchema = z.object({ cypher: z.string().trim().min(1) });
export const AnswerResponseSchema = z.object({ answer: z.string().trim().min(1) });

/**
 * LLM 응답 계약 하나. 검증용 zod 스키마와 `turn/start` 에 넘길 JSON Schema 를 함께 들고 다닌다.
 *
 * 서버가 형식을 보장해도 zod 검증은 남긴다. 지우면 계약이 깨진 날 조용히 넘어간다.
 */
export interface StructuredResponseContract<T> {
  readonly schema: z.ZodType<T>;
  readonly outputSchema: Record<string, unknown>;
}

/** 스키마는 상수이므로 변환은 모듈 로드 때 한 번만 한다. 호출마다 다시 하지 않는다. */
function contractOf<T>(schema: z.ZodType<T>): StructuredResponseContract<T> {
  return { schema, outputSchema: z.toJSONSchema(schema) as Record<string, unknown> };
}

export const AnchorResponseContract = contractOf(AnchorResponseSchema);
export const CypherResponseContract = contractOf(CypherResponseSchema);
export const AnswerResponseContract = contractOf(AnswerResponseSchema);
