import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../auth/types';
import { ConflictError, NotFoundError, UnprocessableError } from '../lib/errors';
import type { PgImageRepository, ListingImage } from '../repositories/postgres/images';
import { sniffImageType, type ImageStorage } from '../storage/imageStorage';
import type { ListingService } from './listingService';

export const MAX_IMAGES_PER_LISTING = 10;

/** The public view: never expose the storage key (an internal file name). */
const publicImage = (img: ListingImage) => ({
  id: img.id,
  listingId: img.listingId,
  contentType: img.contentType,
  sizeBytes: img.sizeBytes,
  url: `/api/v1/listings/${img.listingId}/images/${img.id}`,
  createdAt: img.createdAt,
});

export class ImageService {
  constructor(
    private readonly images: PgImageRepository,
    private readonly storage: ImageStorage,
    private readonly listings: ListingService,
  ) {}

  async upload(user: AuthUser, listingId: string, file: { buffer: Buffer; size: number } | undefined) {
    await this.listings.getForManagement(user, listingId);
    if (!file) throw new UnprocessableError('Attach an image file in the "image" form field');

    const sniffed = sniffImageType(file.buffer);
    if (!sniffed) throw new UnprocessableError('Only JPEG, PNG and WebP images are allowed');
    if ((await this.images.countForListing(listingId)) >= MAX_IMAGES_PER_LISTING) {
      throw new ConflictError(`A listing can have at most ${MAX_IMAGES_PER_LISTING} images`);
    }

    // The stored name is random: never the user's filename (path traversal, overwrites,
    // leaking personal info, or names like "invoice.pdf.exe").
    const id = randomUUID();
    const storageKey = `${id}.${sniffed.ext}`;
    await this.storage.save(storageKey, file.buffer);
    let image: ListingImage;
    try {
      image = await this.images.create({ id, listingId, contentType: sniffed.type, sizeBytes: file.size, storageKey });
    } catch (err) {
      await this.storage.remove(storageKey);
      throw err;
    }
    // The listing's thumbnail (primaryImageUrl) may have changed: refresh cached copies.
    await this.listings.changed([listingId]);
    return publicImage(image);
  }

  async list(listingId: string) {
    await this.listings.get(listingId);
    return (await this.images.listForListing(listingId)).map(publicImage);
  }

  async getFile(listingId: string, imageId: string) {
    await this.listings.get(listingId);
    const img = await this.images.find(listingId, imageId);
    if (!img) throw new NotFoundError('Image', imageId);
    return img;
  }
}
