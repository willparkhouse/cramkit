-- ============================================================================
-- Seed knowledge rows for themrparkhouse@gmail.com so the dashboard's
-- "Knowledge by Module" + "Recommended Time Allocation" + per-module Confidence
-- bars actually have data to display for the demo account.
--
-- Idempotent: re-running upserts the same rows. Doesn't touch other users.
--
-- Strategy: pick ~60% of concepts in each enrolled module and give them a
-- realistic mix of scores (some weak, some medium, some strong) plus a small
-- per-concept history of past attempts spread over the past week. The
-- distribution is intentionally lopsided per module so the bars don't all
-- show the same number — NLP confident, NC moderate, EC weak, SRWS partial.
-- ============================================================================

do $$
declare
  v_user_id      uuid;
  v_concept      record;
  v_module_score numeric;
  v_score        numeric;
  v_history      jsonb;
  v_attempts     int;
  v_last_tested  timestamptz;
  v_module_label text;
begin
  select id into v_user_id from auth.users where email = 'themrparkhouse@gmail.com';
  if v_user_id is null then
    raise exception 'themrparkhouse@gmail.com not found in auth.users — sign in via magic link first';
  end if;

  -- Walk concepts and pick a sample. We bias the score per module so the
  -- dashboard shows a varied profile rather than uniform mush.
  for v_concept in
    select c.id, c.module_ids, c.name, e.slug as module_slug, e.name as module_name
    from public.concepts c
    join lateral unnest(c.module_ids) mid on true
    join public.exams e on e.id = mid
    -- Sample about 60% of concepts deterministically by hashing the id, so
    -- re-runs touch the same rows (idempotency without depending on random()).
    where ('x' || substr(md5(c.id::text), 1, 8))::bit(32)::int % 10 < 6
  loop
    -- Per-module target average score band (mean of the band, ±0.15 jitter):
    --   NLP   ~0.75 confident
    --   NC    ~0.55 moderate
    --   EC    ~0.30 weak
    --   SRWS  ~0.45 partial
    if v_concept.module_slug ilike '%nlp%' then
      v_module_score := 0.75;
      v_module_label := 'NLP';
    elsif v_concept.module_slug ilike '%nc%' or v_concept.module_slug ilike '%neural%' then
      v_module_score := 0.55;
      v_module_label := 'NC';
    elsif v_concept.module_slug ilike '%ec%' or v_concept.module_slug ilike '%evolu%' then
      v_module_score := 0.30;
      v_module_label := 'EC';
    elsif v_concept.module_slug ilike '%srws%' or v_concept.module_slug ilike '%security%' then
      v_module_score := 0.45;
      v_module_label := 'SRWS';
    else
      v_module_score := 0.50;
      v_module_label := 'OTHER';
    end if;

    -- Jitter ±0.18, clamped to [0.05, 0.95], and use the concept id hash so
    -- the same concept always gets the same score on re-runs.
    v_score := v_module_score
      + ((('x' || substr(md5(v_concept.id::text || 'jitter'), 1, 6))::bit(24)::int % 100) / 100.0 - 0.5) * 0.36;
    if v_score < 0.05 then v_score := 0.05; end if;
    if v_score > 0.95 then v_score := 0.95; end if;

    -- 2–6 attempts per concept, last attempt within the past 6 days.
    v_attempts := 2 + (('x' || substr(md5(v_concept.id::text || 'count'), 1, 4))::bit(16)::int % 5);
    v_last_tested := now() - (((('x' || substr(md5(v_concept.id::text || 'when'), 1, 4))::bit(16)::int % 144))::int || ' hours')::interval;

    -- Build a synthetic history array: alternating correct/partial/incorrect
    -- weighted by the final score so the trajectory looks realistic. The
    -- frontend never replays this — it just uses .length and .timestamp.
    v_history := '[]'::jsonb;
    for i in 1..v_attempts loop
      v_history := v_history || jsonb_build_array(jsonb_build_object(
        'timestamp', (v_last_tested - ((v_attempts - i) * interval '8 hours'))::text,
        'question_id', gen_random_uuid()::text,
        'correct', (i::float / v_attempts) <= v_score,
        'score_before', greatest(0, v_score - 0.1 * (v_attempts - i)),
        'score_after',  least(1,  v_score - 0.1 * (v_attempts - i - 1))
      ));
    end loop;

    insert into public.knowledge (user_id, concept_id, score, last_tested, history, updated_at)
    values (v_user_id, v_concept.id, v_score, v_last_tested, v_history, v_last_tested)
    on conflict (user_id, concept_id) do update set
      score = excluded.score,
      last_tested = excluded.last_tested,
      history = excluded.history,
      updated_at = excluded.updated_at;
  end loop;

  raise notice 'seeded knowledge for themrparkhouse@gmail.com';
end $$;

-- Verification: rough per-module averages.
select
  e.name as module,
  count(*) as concepts_with_knowledge,
  round(avg(k.score)::numeric, 2) as avg_score,
  sum(jsonb_array_length(k.history))::int as total_attempts
from public.knowledge k
join public.concepts c on c.id = k.concept_id
join lateral unnest(c.module_ids) mid on true
join public.exams e on e.id = mid
where k.user_id = (select id from auth.users where email = 'themrparkhouse@gmail.com')
group by e.name
order by e.name;
