import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <section className="panel narrow">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to the shop</Link>
      </p>
    </section>
  );
}
