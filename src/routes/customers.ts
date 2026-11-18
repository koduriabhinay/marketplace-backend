import { Router } from 'express';
import { parse } from '../lib/validate';
import { idParamSchema } from '../schemas/common';
import { createCustomerSchema } from '../schemas/customer';
import type { CustomerService } from '../services/customerService';

export function customersRouter(service: CustomerService) {
  const router = Router();

  router.post('/', async (req, res) => {
    const customer = await service.create(parse(createCustomerSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${customer.id}`).json({ data: customer });
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.get(id) });
  });

  return router;
}
