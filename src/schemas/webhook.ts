import { z } from 'zod';
import { EVENT_TYPES } from '../messaging/events';
import { paginationSchema } from './common';

export const createWebhookSchema = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  /** Which events to receive. Defaults to all of them. */
  events: z
    .array(z.enum(EVENT_TYPES))
    .min(1)
    .refine((e) => new Set(e).size === e.length, 'Duplicate event types')
    .default([...EVENT_TYPES]),
});

export const webhookParamsSchema = z.object({ id: z.uuid(), webhookId: z.uuid() });
export const listDeliveriesQuerySchema = paginationSchema;

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export interface WebhookEndpoint {
  id: string;
  sellerId: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'succeeded' | 'dead';
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}
