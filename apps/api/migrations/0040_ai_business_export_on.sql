-- Owner (2026-11-05): «oxirigacha integratsiya» — CSV export of a stored AI report revision is turned on. It exports
-- exactly the stored facts the user already sees (same scope, re-authorised at download); no new data is exposed.
UPDATE feature_flags SET enabled=true WHERE key='ai.business.export';
