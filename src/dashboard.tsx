import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./dashboard.css";

type Payment = {
  id: string;
  amount: string;
  currency: string;
  status: string;
  captured_amount: string;
  refunded_amount: string;
  created_at: string;
};

type Merchant = {
  merchant: { id: string; name: string; email: string; status: string };
  account: { id: string; name: string; currency: string; balance: string };
  api_key: { raw_key: string };
};

const API_BASE = "";

function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("clearwell_api_key") ?? "");
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("12500");
  const [currency, setCurrency] = useState("USD");
  const [card, setCard] = useState("4111111111111111");

  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }),
    [apiKey]
  );

  async function refresh() {
    if (!apiKey) return;
    setLoading(true);
    setError("");
    try {
      const [meResponse, paymentResponse] = await Promise.all([
        fetch(`${API_BASE}/v1/merchants/me`, { headers }),
        fetch(`${API_BASE}/v1/payments`, { headers }),
      ]);
      if (!meResponse.ok) throw new Error("Invalid API key or session expired");
      const me = await meResponse.json();
      setMerchant({
        merchant: me.merchant,
        account: me.accounts?.[0] ?? { id: "", name: "MERCHANT_PAYABLE", currency, balance: "0" },
        api_key: { raw_key: apiKey },
      });
      if (paymentResponse.ok) setPayments(await paymentResponse.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (apiKey) refresh();
  }, [apiKey]);

  async function onboard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${API_BASE}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          currency: form.get("currency"),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Onboarding failed");
      const key = data.api_key.raw_key;
      localStorage.setItem("clearwell_api_key", key);
      setApiKey(key);
      setMerchant(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onboarding failed");
    } finally {
      setLoading(false);
    }
  }

  async function createPayment(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/v1/payments`, {
        method: "POST",
        headers: {
          ...headers,
          "Idempotency-Key": `dashboard-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          amount,
          currency,
          payment_method: {
            card_number: card,
            expiry_month: 12,
            expiry_year: 2099,
            cvv: "123",
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Payment creation failed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment creation failed");
    } finally {
      setLoading(false);
    }
  }

  async function action(paymentId: string, action: "capture" | "void" | "refund") {
    setLoading(true);
    setError("");
    try {
      const endpoint =
        action === "refund"
          ? `${API_BASE}/v1/payments/${paymentId}/refunds`
          : `${API_BASE}/v1/payments/${paymentId}/${action}`;
      const body = action === "refund" ? { amount } : {};
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...headers,
          "Idempotency-Key": `dashboard-${action}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? `${action} failed`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem("clearwell_api_key");
    setApiKey("");
    setMerchant(null);
  }

  if (!apiKey) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand">CLEARWELL</div>
          <h1>Payment operations, clearly.</h1>
          <p>Create a simulated merchant account to open the dashboard.</p>
          <form onSubmit={onboard}>
            <label>Business name<input name="name" required minLength={2} placeholder="Northstar Labs" /></label>
            <label>Email<input name="email" type="email" required placeholder="ops@example.com" /></label>
            <label>Currency<select name="currency"><option>USD</option><option>EUR</option><option>INR</option></select></label>
            {error && <div className="alert">{error}</div>}
            <button disabled={loading}>{loading ? "Creating..." : "Create sandbox merchant"}</button>
          </form>
        </section>
      </main>
    );
  }

  const captured = payments.reduce((sum, p) => sum + BigInt(p.captured_amount || "0"), 0n);
  const refunded = payments.reduce((sum, p) => sum + BigInt(p.refunded_amount || "0"), 0n);

  return (
    <main className="dashboard">
      <aside>
        <div className="brand">CLEARWELL</div>
        <nav>
          <button className="active">Overview</button>
          <button onClick={() => document.querySelector("#payments")?.scrollIntoView()}>Payments</button>
          <button onClick={refresh}>Refresh</button>
        </nav>
        <button className="logout" onClick={logout}>Disconnect</button>
      </aside>
      <section className="content">
        <header>
          <div><p>Sandbox operations</p><h1>{merchant?.merchant.name ?? "Clearwell"}</h1></div>
          <div className="status"><span /> LIVE SIMULATOR</div>
        </header>
        {error && <div className="alert">{error}</div>}
        <div className="metrics">
          <article><p>Payments</p><strong>{payments.length}</strong><span>all statuses</span></article>
          <article><p>Captured</p><strong>{captured.toString()}</strong><span>minor units</span></article>
          <article><p>Refunded</p><strong>{refunded.toString()}</strong><span>minor units</span></article>
          <article><p>Account balance</p><strong>{merchant?.account.balance ?? "0"}</strong><span>{merchant?.account.currency}</span></article>
        </div>
        <section className="panel payment-panel">
          <div><p>New transaction</p><h2>Create a payment</h2></div>
          <form onSubmit={createPayment}>
            <label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" /></label>
            <label>Currency<select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USD</option><option>EUR</option><option>INR</option></select></label>
            <label>Test card<select value={card} onChange={(e) => setCard(e.target.value)}><option value="4111111111111111">4111 •••• Success</option><option value="4000000000000002">4000 •••• Decline</option><option value="4000000000000003">4000 •••• Timeout</option></select></label>
            <button disabled={loading}>{loading ? "Processing..." : "Authorize payment"}</button>
          </form>
        </section>
        <section className="panel" id="payments">
          <div className="panel-heading"><div><p>Activity</p><h2>Recent payments</h2></div><button className="secondary" onClick={refresh}>Refresh</button></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Payment</th><th>Amount</th><th>Status</th><th>Captured</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {payments.length === 0 && <tr><td colSpan={6} className="empty">No payments yet</td></tr>}
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td><code>{payment.id.slice(0, 8)}</code></td>
                    <td>{payment.amount} {payment.currency}</td>
                    <td><span className={`badge-status ${payment.status.toLowerCase()}`}>{payment.status}</span></td>
                    <td>{payment.captured_amount}</td>
                    <td>{new Date(payment.created_at).toLocaleString()}</td>
                    <td className="row-actions">
                      {["AUTHORIZED", "CAPTURE_PENDING"].includes(payment.status) && <button onClick={() => action(payment.id, "capture")}>Capture</button>}
                      {payment.status === "AUTHORIZED" && <button onClick={() => action(payment.id, "void")}>Void</button>}
                      {["CAPTURED", "PARTIALLY_REFUNDED"].includes(payment.status) && <button onClick={() => action(payment.id, "refund")}>Refund</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
