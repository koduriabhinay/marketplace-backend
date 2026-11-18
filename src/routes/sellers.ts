import { Router } from 'express';
import { authenticate, requireRole } from '../auth/middleware';
import { assertCanManageSeller } from '../auth/policies';
import { parse } from '../lib/validate';
import { idParamSchema } from '../schemas/common';
import { createSellerSchema, listSellersQuerySchema, updateSellerSchema } from '../schemas/seller';
import { createWebhookSchema, listDeliveriesQuerySchema, webhookParamsSchema } from '../schemas/webhook';
import type { SellerService } from '../services/sellerService';
import type { WebhookService } from '../webhooks/webhookService';

export function sellersRouter(service: SellerService, webhooks: WebhookService) {
  const router = Router();

  // Sellers normally sign up via POST /auth/register; this is an admin back-office tool.
  router.post('/', authenticate, requireRole('admin'), async (req, res) => {
    const seller = await service.create(parse(createSellerSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${seller.id}`).json({ data: seller });
  });

  // Seller storefront profiles are public.
  router.get('/', async (req, res) => {
    res.json(await service.list(parse(listSellersQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.get(id) });
  });

  router.patch('/:id', authenticate, async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    assertCanManageSeller(req.user!, id);
    res.json({ data: await service.update(id, parse(updateSellerSchema, req.body)) });
  });

  // Webhook endpoints: only the seller (or an admin) can see or change them.
  router.post('/:id/webhooks', authenticate, async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const endpoint = await webhooks.register(req.user!, id, parse(createWebhookSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${id}/webhooks/${endpoint.id}`).json({ data: endpoint });
  });

  router.get('/:id/webhooks', authenticate, async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await webhooks.list(req.user!, id) });
  });

  router.delete('/:id/webhooks/:webhookId', authenticate, async (req, res) => {
    const { id, webhookId } = parse(webhookParamsSchema, req.params);
    await webhooks.remove(req.user!, id, webhookId);
    res.status(204).end();
  });

  router.get('/:id/webhooks/:webhookId/deliveries', authenticate, async (req, res) => {
    const { id, webhookId } = parse(webhookParamsSchema, req.params);
    res.json(await webhooks.deliveries(req.user!, id, webhookId, parse(listDeliveriesQuerySchema, req.query)));
  });

  return router;
}
