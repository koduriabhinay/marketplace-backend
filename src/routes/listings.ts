import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env';
import { authenticate } from '../auth/middleware';
import { parse } from '../lib/validate';
import { idParamSchema } from '../schemas/common';
import { createListingSchema, listListingsQuerySchema, updateListingSchema } from '../schemas/listing';
import type { ImageService } from '../services/imageService';
import type { ListingService } from '../services/listingService';

const imageParamsSchema = z.object({ id: z.uuid(), imageId: z.uuid() });

/**
 * Uploads are held in memory (bounded by MAX_UPLOAD_BYTES) so we can inspect the bytes
 * before anything touches disk. One file, no extra fields.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 2 },
});

export function listingsRouter(service: ListingService, images: ImageService, uploadRoot: string) {
  const router = Router();

  router.post('/', authenticate, async (req, res) => {
    const listing = await service.create(req.user!, parse(createListingSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${listing.id}`).json({ data: listing });
  });

  // Browsing the catalog is public.
  router.get('/', async (req, res) => {
    res.json(await service.list(parse(listListingsQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.get(id) });
  });

  router.patch('/:id', authenticate, async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.update(req.user!, id, parse(updateListingSchema, req.body)) });
  });

  router.delete('/:id', authenticate, async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    await service.remove(req.user!, id);
    res.status(204).end();
  });

  router.post('/:id/images', authenticate, upload.single('image'), async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const image = await images.upload(req.user!, id, req.file);
    res.status(201).location(image.url).json({ data: image });
  });

  router.get('/:id/images', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await images.list(id) });
  });

  router.get('/:id/images/:imageId', async (req, res) => {
    const { id, imageId } = parse(imageParamsSchema, req.params);
    const img = await images.getFile(id, imageId);
    // Content-Type comes from our own sniffing, never the uploader's claim; nosniff
    // (from helmet) stops browsers second-guessing it; a strict CSP neuters any payload.
    res.setHeader('Content-Type', img.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${img.id}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.sendFile(img.storageKey, { root: uploadRoot, dotfiles: 'deny' });
  });

  return router;
}
