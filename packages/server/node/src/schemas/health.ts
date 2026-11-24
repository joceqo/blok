import { z } from 'zod';

export const healthBodySchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});