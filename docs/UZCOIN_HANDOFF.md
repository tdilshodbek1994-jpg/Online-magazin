# UzCoin — handoff
- API partner: `GET /partner/uzcoin`, `GET /partner/uzcoin/preview?coins=`, `POST /partner/uzcoin/exchanges` (Idempotency-Key), `GET /partner/uzcoin/gifts`, `POST /partner/uzcoin/gifts/:id/order` (Idempotency-Key), `POST /partner/uzcoin/gift-orders/:id/cancel`.
- API admin: `GET /admin/uzcoin/report`, `POST /admin/uzcoin/rates` (owner), `GET|POST /admin/uzcoin/gifts`, `PUT /admin/uzcoin/gifts/:id` (expected_version), `GET /admin/uzcoin/queues`, `POST /admin/uzcoin/exchanges/:id/{approve|reject}` (step-up), `POST /admin/uzcoin/gift-orders/:id/status`.
- Next: full gift editor (media upload, variants), rate announcement screen, AI read-only explainer, optional coin→charity (separate consent/operation), reconciliation export.
