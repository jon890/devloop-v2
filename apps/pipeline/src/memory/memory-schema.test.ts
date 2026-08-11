import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson, SourceRefSchema, sourceRefKey } from "@devloop/shared";

describe("Memory 공유 계약", () => {
  it("canonical JSON은 object key만 정렬하고 array 순서는 보존한다", () => {
    assert.equal(canonicalJson({ z: [{ b: 2, a: 1 }, 3], a: "first" }), '{"a":"first","z":[{"a":1,"b":2},3]}');
  });

  it("sourceRefKey는 sourceType:sourceId 계약 하나만 사용한다", () => {
    assert.equal(sourceRefKey({ sourceType: "git-file", sourceId: "OCR.API@abc:README.md" }), "git-file:OCR.API@abc:README.md");
  });

  it("Git과 Dooray comment의 조건부 필드를 강제한다", () => {
    assert.throws(
      () => SourceRefSchema.parse({ sourceType: "git-file", sourceId: "id", title: "file", url: "https://example.com/file" }),
      /repository/,
    );
    assert.throws(
      () => SourceRefSchema.parse({ sourceType: "dooray-comment", sourceId: "c1", title: "comment", url: "https://example.com/task" }),
      /parentId/,
    );
    assert.throws(
      () =>
        SourceRefSchema.parse({
          sourceType: "git-commit",
          sourceId: "wrong",
          repository: "OCR.API",
          revision: "a".repeat(40),
          title: "commit",
          url: `https://example.com/commit/${"a".repeat(40)}`,
        }),
      /sourceId 계약/,
    );
  });
});
