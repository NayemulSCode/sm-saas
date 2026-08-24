# ADR-0020 — Provider-agnostic payments with an explicit `unknown` state

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1B

## Context

Online payment is Phase 2 — cash and bank recording ship first, because in this
market the first fifty schools collect most fees at the counter
([§2.5](../phase-1a/02-domain-analysis.md)). But the abstraction must be decided
now so the cash path and the online path produce the same receipt, the same
allocation and the same audit trail.

The hard problem in Bangladeshi payments is not the provider. It is the **lost
callback**: money leaves the guardian's wallet and the IPN never arrives.

## Options

### A. Integrate one provider directly
Fastest. Couples the finance domain to one vendor's vocabulary and state names,
and offers no path when a masked-sender or merchant approval stalls.

### B. Provider interface with adapters, happy path only
Better, but omits `queryStatus` and settlement reconciliation — which is exactly
the part that matters and exactly the part that is easy to skip.

### C. Provider interface including status query, settlement parsing and refunds,
with `unknown` as a first-class state

## Decision

**C.**

```ts
interface PaymentProvider {
  createSession(req): Promise<{ redirectUrl; providerRef }>;
  verifySignature(raw, headers): boolean;
  parseCallback(raw): ProviderEvent;
  queryStatus(providerRef): Promise<ProviderStatus>;   // the repair path
  refund(providerRef, amount): Promise<RefundResult>;
  parseSettlementFile(csv): SettlementRow[];
}
```

`unknown` is a state in the machine, not an error condition. A transaction with
no IPN after a timeout moves to `unknown` and is resolved by, in order: a
`queryStatus` reconciliation job, a settlement-file match, and finally a **manual
repair workflow** with approval and audit.

Fixed rules regardless of provider:

| Rule | Reason |
|---|---|
| Verify the signature **before** parsing | An unverified payload is attacker-controlled |
| `UNIQUE (provider, provider_ref, event_type)` | The unique index **is** the replay protection |
| Store the raw payload | Disputes are settled by what the provider actually sent |
| Respond 200 fast, process asynchronously | Providers retry aggressively on slow responses |
| Cross-check the amount against the initiated charge | Never trust the callback's amount alone |
| A verified success flows into the **same** `recordPayment` path as cash | One receipt format, one audit trail, one reconciliation |

Initial candidate: SSLCommerz, because it fronts cards plus bKash, Nagad and
Rocket in BDT — one integration for several rails. Second adapter chosen on
observed settlement reliability, not on marketing.

## Consequences

**Makes easy:** switching or adding providers; testing the finance domain with a
fake adapter and no sandbox; a single reconciliation model across channels.

**Makes hard:** more surface to implement than a happy-path integration, and
`queryStatus` semantics differ per provider. Accepted — that difference is the
reason the interface exists.

**Forecloses:** nothing. Cash remains a first-class channel, not a degraded case.

## Revisit when

- A provider's settlement file or status API proves unreliable enough that
  reconciliation cannot close — then change provider, which is the point.
- The platform begins holding funds on a school's behalf, which changes the
  regulatory position and probably requires double-entry
  ([§17.11](../phase-1b/17-finance-architecture.md)).
