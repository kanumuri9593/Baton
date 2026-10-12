import { useState } from 'react';
import { orders } from './orders.js';

export default function App() {
  const [selected, setSelected] = useState(orders[0].id);
  const banner = 'Out for delivery';
  return (
    <main className="app">
      <header>
        <h1>Delivery tracker</h1>
        <p className="banner">{banner}</p>
      </header>
      <ul className="orders">
        {orders.map((o) => (
          <li key={o.id} className={o.id === selected ? 'selected' : ''} onClick={() => setSelected(o.id)}>
            <strong>{o.id}</strong> {o.customer} · {o.items} items · ETA {o.eta}
            <span className="status">{o.status}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
