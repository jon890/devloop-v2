import { z } from 'zod';

export const RawDoorayObjectSchema = z.record(z.string(), z.unknown());
export type RawDoorayObject = z.infer<typeof RawDoorayObjectSchema>;

export const RawPostsSchema = z.array(RawDoorayObjectSchema);
export type RawPosts = z.infer<typeof RawPostsSchema>;

export const RawPostDocumentSchema = z.object({
  post: RawDoorayObjectSchema,
  comments: z.array(RawDoorayObjectSchema),
});
export type RawPostDocument = z.infer<typeof RawPostDocumentSchema>;

export const RawWikiPageSchema = RawDoorayObjectSchema;
export type RawWikiPage = z.infer<typeof RawWikiPageSchema>;

export const RawNameMapSchema = z.record(z.string(), z.string());
export type RawNameMap = z.infer<typeof RawNameMapSchema>;

export const RawProjectManifestSchema = z.object({
  project: z.string().min(1),
  posts: RawPostsSchema,
  tags: RawNameMapSchema,
  members: RawNameMapSchema,
});
export type RawProjectManifest = z.infer<typeof RawProjectManifestSchema>;
