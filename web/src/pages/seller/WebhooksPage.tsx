import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { webhooksApi } from '../../api/endpoints';
import { EVENT_TYPES, type EventType, type WebhookEndpoint } from '../../api/types';
import { useAuth } from '../../auth/AuthProvider';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { formatDate } from '../../lib/format';

export function WebhooksPage() {
  const { user } = useAuth();
  const sellerId = user!.sellerId!;
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<EventType[]>([...EVENT_TYPES]);
  const [secret, setSecret] = useState<string | null>(null);

  const endpoints = useQuery({
    queryKey: ['webhooks', sellerId],
    queryFn: () => webhooksApi.list(sellerId),
    meta: { private: true },
  });
  const create = useMutation({
    mutationFn: () => webhooksApi.create(sellerId, url.trim(), events),
    onSuccess: (created) => {
      setSecret(created.secret);
      setUrl('');
      void queryClient.invalidateQueries({ queryKey: ['webhooks', sellerId] });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSecret(null);
    create.mutate();
  }

  const toggleEvent = (ev: EventType) =>
    setEvents((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]));

  return (
    <section className="stack">
      <p className="muted">
        <Link to="/seller">← Seller dashboard</Link>
      </p>
      <h1>Webhooks</h1>
      <p>
        We send a signed HTTPS POST to your server whenever an order with your products is placed or cancelled. Failed
        deliveries are retried with backoff for up to a day.
      </p>

      <form className="panel form" onSubmit={onSubmit}>
        <h2>Add an endpoint</h2>
        <label>
          URL
          <input type="url" required placeholder="https://example.com/hooks/marketplace" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <fieldset className="checks">
          <legend>Events</legend>
          {EVENT_TYPES.map((ev) => (
            <label key={ev}>
              <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} /> <code>{ev}</code>
            </label>
          ))}
        </fieldset>
        <ErrorAlert error={create.error} />
        <div className="actions">
          <button className="button" disabled={create.isPending || events.length === 0}>
            {create.isPending ? 'Adding…' : 'Add endpoint'}
          </button>
        </div>
      </form>

      {secret && (
        <Alert kind="success">
          <strong>Copy your signing secret now.</strong> It is shown once and can't be retrieved again.
          <code className="secret">{secret}</code>
          Use it to check the <code>webhook-signature</code> header on every request.
        </Alert>
      )}

      {endpoints.isPending && <Spinner label="Loading endpoints" />}
      <ErrorAlert error={endpoints.error} />
      {endpoints.data?.length === 0 && <p className="muted">No endpoints yet.</p>}
      {endpoints.data?.map((ep) => <Endpoint key={ep.id} sellerId={sellerId} endpoint={ep} />)}
    </section>
  );
}

function Endpoint({ sellerId, endpoint }: { sellerId: string; endpoint: WebhookEndpoint }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const deliveries = useQuery({
    queryKey: ['webhooks', sellerId, endpoint.id, 'deliveries'],
    queryFn: () => webhooksApi.deliveries(sellerId, endpoint.id),
    enabled: open,
    refetchInterval: open ? 5_000 : false, // watch retries happen live
    meta: { private: true },
  });
  const remove = useMutation({
    mutationFn: () => webhooksApi.remove(sellerId, endpoint.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks', sellerId] }),
  });

  return (
    <div className="panel">
      <div className="page-head">
        <div>
          <code className="break">{endpoint.url}</code>
          <p className="muted small">
            {endpoint.events.join(', ')} · added {formatDate(endpoint.createdAt)}
          </p>
        </div>
        <div className="actions">
          <button type="button" className="button secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide deliveries' : 'Deliveries'}
          </button>
          <button
            type="button"
            className="button secondary danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm('Delete this endpoint? Pending deliveries to it stop.')) remove.mutate();
            }}
          >
            Delete
          </button>
        </div>
      </div>
      <ErrorAlert error={remove.error} />
      {open && (
        <>
          {deliveries.isPending && <Spinner label="Loading deliveries" />}
          <ErrorAlert error={deliveries.error} />
          {deliveries.data?.data.length === 0 && <p className="muted">No deliveries yet. Place an order to trigger one.</p>}
          {!!deliveries.data?.data.length && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Status</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Last response</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.data.data.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <code>{d.eventType}</code>
                      </td>
                      <td>
                        <span className={`status status-${d.status}`}>{d.status}</span>
                        {d.status === 'pending' && d.nextAttemptAt && (
                          <div className="muted small">next try {formatDate(d.nextAttemptAt)}</div>
                        )}
                      </td>
                      <td>{d.attempts}</td>
                      <td className="small">{d.lastStatusCode ?? d.lastError ?? '—'}</td>
                      <td className="small">{formatDate(d.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
