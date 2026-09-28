import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);

const modelChoiceSchema = z.object({
  id: z.number().int(),
  name: nonEmptyText,
  reason: nonEmptyText,
  preferWhen: nonEmptyText.nullable(),
});

export const modelRecommendationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["augment", "item"]),
  primary: z.object({
    id: z.number().int(),
    name: nonEmptyText,
    reason: nonEmptyText,
  }),
  alternatives: z.array(modelChoiceSchema).max(2),
  buildDirection: nonEmptyText.nullable(),
  warnings: z.array(nonEmptyText),
  confidence: z.enum(["high", "medium", "low"]),
});

export type ModelRecommendation = z.infer<typeof modelRecommendationSchema>;

