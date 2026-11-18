import { Router } from 'express';
import { authenticate, requireRole } from '../auth/middleware';
import { assertCanSeeCustomerResource } from '../auth/policies';
import { parse } from '../lib/validate';
import { idParamSchema } from '../schemas/common';
import { createCustomerSchema } from '../schemas/customer';
import type { CustomerService } from '../services/customerService';

export function customersRouter(service: CustomerService) {
  const router = Router();
  router.use(authenticate);

  // Customers normally sign up via POST /auth/register; this is an admin back-office tool.
  router.post('/', requireRole('admin'), async (req, res) => {
    const customer = await service.create(parse(createCustomerSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${customer.id}`).json({ data: customer });
  });

  // Customer profiles hold personal data: only the customer themselves or an admin.
  router.get('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    assertCanSeeCustomerResource(req.user!, id, 'Customer', id);
    res.json({ data: await service.get(id) });
  });

  return router;
}
