import { Router, type RequestHandler } from 'express';
import { authenticate } from '../auth/middleware';
import { parse } from '../lib/validate';
import { idParamSchema } from '../schemas/common';
import { createOrderSchema, listOrdersQuerySchema } from '../schemas/order';
import type { OrderService } from '../services/orderService';

export function ordersRouter(service: OrderService, idempotency: RequestHandler) {
  const router = Router();
  router.use(authenticate);

  // Checkout is the request clients most need to retry safely: send an Idempotency-Key.
  router.post('/', idempotency, async (req, res) => {
    const order = await service.place(req.user!, parse(createOrderSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${order.id}`).json({ data: order });
  });

  router.get('/', async (req, res) => {
    res.json(await service.list(req.user!, parse(listOrdersQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.get(req.user!, id) });
  });

  // A state transition, not a field edit, so it's an action endpoint rather than PATCH.
  router.post('/:id/cancel', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.cancel(req.user!, id) });
  });

  return router;
}
