import { Router } from 'express';
import { parse } from '../lib/validate';
import { idParamSchema } from '../schemas/common';
import { createOrderSchema, listOrdersQuerySchema } from '../schemas/order';
import type { OrderService } from '../services/orderService';

export function ordersRouter(service: OrderService) {
  const router = Router();

  router.post('/', async (req, res) => {
    const order = await service.place(parse(createOrderSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${order.id}`).json({ data: order });
  });

  router.get('/', async (req, res) => {
    res.json(await service.list(parse(listOrdersQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.get(id) });
  });

  // A state transition, not a field edit, so it's an action endpoint rather than PATCH.
  router.post('/:id/cancel', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.cancel(id) });
  });

  return router;
}
