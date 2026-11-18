import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError } from '../../api/client';
import { listingsApi } from '../../api/endpoints';
import type { Listing, ListingInput, ListingStatus } from '../../api/types';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { centsToInput, parseMoney } from '../../lib/format';

const ACCEPTED = 'image/jpeg,image/png,image/webp';
const MAX_BYTES = 2 * 1024 * 1024; // the API's limit; checked here only to fail fast

export function ListingEditor() {
  const { id } = useParams();
  const listing = useQuery({
    queryKey: ['listing', id, 'manage'],
    queryFn: ({ signal }) => listingsApi.get(id!, signal),
    enabled: !!id,
  });

  if (id && listing.isPending) return <Spinner label="Loading listing" />;
  if (id && listing.error) return <ErrorAlert error={listing.error} />;
  return (
    <section className="stack">
      <p className="muted">
        <Link to="/seller">← Seller dashboard</Link>
      </p>
      <h1>{id ? 'Edit listing' : 'New listing'}</h1>
      <ListingForm key={id ?? 'new'} existing={listing.data} />
      {id && listing.data && <Images listing={listing.data} />}
    </section>
  );
}

function ListingForm({ existing }: { existing?: Listing }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    title: existing?.title ?? '',
    description: existing?.description ?? '',
    price: existing ? centsToInput(existing.priceCents) : '',
    stock: existing ? String(existing.stock) : '1',
    status: existing?.status ?? ('active' as ListingStatus),
  });
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (input: ListingInput) => (existing ? listingsApi.update(existing.id, input) : listingsApi.create(input)),
    onSuccess: (l) => {
      void queryClient.invalidateQueries({ queryKey: ['listings'] });
      queryClient.setQueryData(['listing', l.id], l);
      queryClient.setQueryData(['listing', l.id, 'manage'], l);
      if (existing) setSaved(true);
      else navigate(`/seller/listings/${l.id}`, { replace: true, state: { created: true } });
    },
  });

  const serverErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const errors = { ...serverErrors, ...localErrors };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [k]: e.target.value });
    setSaved(false);
  };

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const priceCents = parseMoney(form.price);
    const stock = Number(form.stock);
    const problems: Record<string, string> = {};
    if (priceCents === null || priceCents < 1) problems.priceCents = 'Enter a price like 19.99';
    if (!Number.isInteger(stock) || stock < 0) problems.stock = 'Enter a whole number, 0 or more';
    setLocalErrors(problems);
    if (Object.keys(problems).length) return;
    save.mutate({
      title: form.title.trim(),
      description: form.description.trim(),
      priceCents: priceCents!,
      stock,
      status: form.status,
    });
  }

  return (
    <form className="panel form" onSubmit={onSubmit} noValidate>
      <label>
        Title
        <input required minLength={3} maxLength={200} value={form.title} onChange={set('title')} />
        {errors.title && <span className="field-error">{errors.title}</span>}
      </label>
      <label>
        Description
        <textarea rows={5} maxLength={5000} value={form.description} onChange={set('description')} />
        {errors.description && <span className="field-error">{errors.description}</span>}
      </label>
      <div className="row">
        <label>
          Price (USD)
          <input inputMode="decimal" placeholder="19.99" required value={form.price} onChange={set('price')} />
          {errors.priceCents && <span className="field-error">{errors.priceCents}</span>}
        </label>
        <label>
          Stock
          <input type="number" min={0} step={1} required value={form.stock} onChange={set('stock')} />
          {errors.stock && <span className="field-error">{errors.stock}</span>}
        </label>
        <label>
          Status
          <select value={form.status} onChange={set('status')}>
            <option value="active">On sale</option>
            <option value="inactive">Hidden</option>
          </select>
        </label>
      </div>
      {save.error && !Object.keys(serverErrors).length ? <ErrorAlert error={save.error} /> : null}
      {saved && <Alert kind="success">Saved.</Alert>}
      <div className="actions">
        <button className="button" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Create listing'}
        </button>
      </div>
    </form>
  );
}

function Images({ listing }: { listing: Listing }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [tooBig, setTooBig] = useState(false);
  const images = useQuery({
    queryKey: ['listing', listing.id, 'images'],
    queryFn: ({ signal }) => listingsApi.images(listing.id, signal),
  });
  const upload = useMutation({
    mutationFn: (file: File) => listingsApi.uploadImage(listing.id, file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['listing', listing.id] });
      void queryClient.invalidateQueries({ queryKey: ['listings'] });
      if (input.current) input.current.value = '';
    },
  });

  function onFile(file: File | undefined) {
    setTooBig(false);
    if (!file) return;
    if (file.size > MAX_BYTES) return setTooBig(true);
    upload.mutate(file);
  }

  return (
    <div className="panel">
      <h2>Photos</h2>
      <p className="muted small">JPEG, PNG or WebP, up to 2 MB, at most 10. The first photo is the one shoppers see in the shop.</p>
      {images.isPending && <Spinner label="Loading photos" />}
      <div className="photo-grid">
        {images.data?.map((img, i) => (
          <figure key={img.id}>
            <img src={img.url} alt={`Photo ${i + 1} of ${listing.title}`} />
            {i === 0 && <figcaption>Main photo</figcaption>}
          </figure>
        ))}
      </div>
      <label className="upload">
        <span className="button secondary">{upload.isPending ? 'Uploading…' : 'Add a photo'}</span>
        <input
          ref={input}
          type="file"
          accept={ACCEPTED}
          className="visually-hidden"
          disabled={upload.isPending}
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </label>
      {tooBig && <Alert>That file is larger than 2 MB.</Alert>}
      <ErrorAlert error={upload.error} />
    </div>
  );
}
