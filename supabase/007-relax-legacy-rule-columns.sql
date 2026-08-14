-- ============================================================================
-- 007 — allow NULL in the legacy single-condition rule columns
--
-- WHY: creating a v2 multi-condition rule failed with
--     null value in column "rule_type" of relation "template_rules"
--     violates not-null constraint
--
-- rule_type / rule_operator / rule_value predate migration 002. That migration
-- added `conditions` + `condition_mode` and marked the old triple deprecated,
-- but left the NOT NULL constraints in place — so a rule that expresses itself
-- purely through `conditions` had nothing valid to put in them.
--
-- Existing legacy rows keep their values and keep resolving: the resolver reads
-- `conditions` first and only falls back to this triple when the array is empty.
--
-- Safe to run before or after deploying the app: the API writes a 'conditions'
-- marker rather than NULL so it works either way, and starts writing NULL only
-- once this has run.
-- ============================================================================

begin;

alter table public.template_rules alter column rule_type     drop not null;
alter table public.template_rules alter column rule_operator drop not null;
alter table public.template_rules alter column rule_value    drop not null;

comment on column public.template_rules.rule_type is
  'DEPRECATED single-condition model. NULL (or the marker ''conditions'') means the rule is defined by the conditions jsonb.';

commit;

-- ── Optional tidy-up ────────────────────────────────────────────────────────
-- Once this migration has run, v2 rules can store NULL instead of the marker:
--
--   update public.template_rules
--   set rule_type = null, rule_operator = null, rule_value = null
--   where rule_type = 'conditions' and jsonb_array_length(conditions) > 0;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select column_name, is_nullable
--   from information_schema.columns
--   where table_name = 'template_rules'
--     and column_name in ('rule_type','rule_operator','rule_value');
--   -- all three must report is_nullable = YES
