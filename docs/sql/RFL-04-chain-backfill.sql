-- RFL-04 — one-off chain / franchise backfill for existing businesses rows
-- (audit finding 3). Requires migration 0008 (chain_reason, name_normalized).
--
-- WRITE-ONLY from Claude Code. Joey pastes this into the Supabase web SQL
-- editor himself; nothing here has been executed by tooling.
--
-- Applies the worker's three rules (apps/worker/src/lib/chains.ts) to the
-- rows Scout wrote before RFL-04, as SQL approximations:
--
--   known_brand    name_normalized starts with a brand token sequence
--                  (the list below mirrors KNOWN_CHAIN_BRANDS; "=" entries
--                  there are exact-only and are matched with = here)
--   url_shape      website_url is a store-locator page: a salons./locations./
--                  stores./local. subdomain, a /stores|locations|l|nearme|
--                  store-locator/ path on a domain that is not the business's
--                  own name, or such a path plus a numeric store id
--   multi_location same name_normalized at ≥3 distinct google_place_id in
--                  the workspace
--
-- It sets ONLY is_chain and chain_reason. Scores are not recomputed: the
-- sellability cap (≤40) and the exclude_chains default apply on the next
-- audit of each business. Rows already is_chain keep is_chain; their
-- chain_reason is filled in when null.
--
-- HOW TO RUN
--   1. Select PART 1 and run it (read-only). It lists every row that would
--      flip or get a reason, with the rule that fires. Eyeball it: anything
--      local that is wrongly listed → add its exact name to the NOT IN list
--      in PART 2 (marked "local exceptions") before running.
--   2. Select PART 2 and run it (one transaction).
--   3. Select PART 3 and run it (read-only) to verify.


-- ===========================================================================
-- Shared rule definitions (temp views; recreated by each part)
-- ===========================================================================

create or replace temp view rfl04_brands as
select brand, exact_only from (values
  -- hair / beauty
  ('ulta beauty', false), ('ulta', false), ('sephora', false), ('supercuts', false),
  ('sport clips', false), ('sportclips', false), ('great clips', false),
  ('smartstyle', false), ('smart style', false), ('fantastic sams', false),
  ('cost cutters', false), ('hair cuttery', false), ('first choice haircutters', false),
  ('roosters', false), ('floyds 99', false), ('floyds barbershop', false),
  ('lady janes', false), ('cookie cutters', false), ('snip its', false),
  ('pigtails crewcuts', false), ('sharkeys cuts for kids', false), ('regis salon', false),
  ('regis', true), ('mastercuts', false), ('hair masters', false), ('hairmasters', false),
  ('signature style', false), ('holiday hair', false), ('borics', false), ('famous hair', false),
  ('paul mitchell the school', false), ('paul mitchell school', false), ('paul mitchell schools', false),
  ('aveda institute', false), ('aveda arts sciences institute', false), ('toni guy', false),
  ('drybar', false), ('blo blow dry bar', false), ('european wax center', false),
  ('european wax', false), ('radiant waxing', false), ('waxing the city', false),
  ('wax center', true), ('sugared bronzed', false), ('benefit brow bar', false),
  ('amazing lash studio', false), ('lash lounge', false), ('deka lash', false),
  ('massage envy', false), ('hand and stone', false), ('hand stone', false),
  ('elements massage', false), ('joint chiropractic', false), ('sola salon studios', false),
  ('sola salons', false), ('phenix salon suites', false), ('salons by jc', false),
  ('my salon suite', false), ('palm beach tan', false), ('sun tan city', false),
  ('hollywood tans', false), ('regal nails', false), ('nail bar', true),
  -- trades / home services
  ('roto rooter', false), ('mr rooter', false), ('benjamin franklin plumbing', false),
  ('ars rescue rooter', false), ('ars', true), ('one hour heating', false),
  ('one hour air conditioning', false), ('aire serv', false), ('mr electric', false),
  ('mister sparky', false), ('mr appliance', false), ('mr handyman', false),
  ('handyman connection', false), ('ace handyman services', false), ('horizon services', false),
  ('service experts', false), ('sila', true), ('lennox stores', false),
  ('american residential services', false), ('bluefrog plumbing', false), ('zoom drain', false),
  ('grounds guys', false), ('rainbow restoration', false), ('rainbow international', false),
  ('servpro', false), ('servicemaster', false), ('paul davis', false), ('puroclean', false),
  ('belfor', true), ('dryer vent wizard', false), ('window genie', false),
  ('fish window cleaning', false), ('shelfgenie', false), ('glass doctor', false),
  ('precision door service', false), ('precision garage door', false), ('overhead door', false),
  ('neighborly', false), ('dream doors', false), ('closets by design', false),
  ('california closets', false), ('bath fitter', false), ('re bath', false), ('rebath', false),
  ('west shore home', false), ('leaffilter', false), ('leaf filter', false), ('leafguard', false),
  ('leaf guard', false), ('renewal by andersen', false), ('champion windows', false),
  ('window world', false), ('window nation', false), ('power home remodeling', false),
  ('stanley steemer', false), ('chem dry', false), ('oxi fresh', false), ('zerorez', false),
  ('coit', true), ('terminix', false), ('orkin', false), ('rentokil', false), ('aptive', true),
  ('mosquito joe', false), ('mosquito squad', false), ('mosquito authority', false),
  ('trugreen', false), ('lawn doctor', false), ('weed man', false), ('lawn squad', false),
  ('molly maid', false), ('merry maids', false), ('maids', true), ('cleaning authority', false),
  ('two maids', false), ('maidpro', false), ('1 800 got junk', false), ('1800gotjunk', false),
  ('junk king', false), ('college hunks', false), ('two men and a truck', false),
  ('u haul', false), ('uhaul', false), ('certapro', false), ('five star painting', false),
  ('wow 1 day painting', false), ('fresh coat painters', false),
  ('home services at the home depot', false), ('home depot', false), ('lowes', false),
  ('ace hardware', false), ('sherwin williams', false), ('pella windows', false),
  ('andersen windows', false), ('angi', true), ('angie s list', false), ('homeadvisor', false),
  -- dental / medical
  ('aspen dental', false), ('western dental', false), ('pacific dental services', false),
  ('heartland dental', false), ('smile brands', false), ('bright now dental', false),
  ('monarch dental', false), ('castle dental', false), ('gentle dental', false),
  ('affordable dentures', false), ('comfort dental', false), ('kool smiles', false),
  ('smile direct club', false), ('smiledirectclub', false), ('clearchoice', false),
  ('clear choice dental implant', false), ('familia dental', false), ('midwest dental', false),
  ('sonrava', false), ('dental works', false), ('dentalworks', false), ('coast dental', false),
  ('invisalign', false), ('myeyedr', false), ('lenscrafters', false), ('pearle vision', false),
  ('visionworks', false), ('americas best', false), ('eyemart express', false),
  ('target optical', false), ('walmart vision', false), ('concentra', false), ('fastmed', false),
  ('medexpress', false), ('carenow', false), ('patient first', false), ('minuteclinic', false),
  ('cvs', true), ('walgreens', false), ('rite aid', false), ('banfield', false),
  ('vca animal hospital', false), ('vca', true), ('petsmart', false), ('petco', false),
  -- fitness
  ('planet fitness', false), ('anytime fitness', false), ('orangetheory', false),
  ('orange theory', false), ('snap fitness', false), ('crunch fitness', false), ('crunch', true),
  ('24 hour fitness', false), ('la fitness', false), ('golds gym', false), ('gold s gym', false),
  ('club pilates', false), ('pure barre', false), ('cyclebar', false), ('yogasix', false),
  ('yoga six', false), ('stretchlab', false), ('row house', false), ('rumble boxing', false),
  ('akt', true), ('bft', true), ('f45', false), ('burn boot camp', false), ('9round', false),
  ('9 round', false), ('bar method', false), ('barre3', false), ('corepower yoga', false),
  ('ymca', false), ('curves', true), ('jazzercise', false), ('d1 training', false),
  ('exercise coach', false), ('camp transformation center', false), ('eos fitness', false),
  ('vasa fitness', false), ('chuze fitness', false), ('in shape', true), ('lifetime fitness', false),
  ('life time', true), ('equinox', true), ('ufc gym', false), ('title boxing club', false),
  ('mayweather boxing fitness', false), ('ilovekickboxing', false), ('i love kickboxing', false),
  ('workout anytime', false), ('retro fitness', false), ('blink fitness', false), ('youfit', false),
  ('fitness 19', false), ('club fitness', true), ('little gym', false), ('my gym', true),
  -- restaurants / food
  ('mcdonalds', false), ('burger king', false), ('wendys', false), ('starbucks', false),
  ('dutch bros', false), ('subway', true), ('jersey mikes', false), ('jimmy johns', false),
  ('firehouse subs', false), ('dominos', false), ('pizza hut', false), ('papa johns', false),
  ('papa murphys', false), ('little caesars', false), ('marcos pizza', false), ('mod pizza', false),
  ('blaze pizza', false), ('chipotle', false), ('qdoba', false), ('taco bell', false),
  ('taco johns', false), ('del taco', false), ('cafe rio', false), ('costa vida', false),
  ('panda express', false), ('panera bread', false), ('chick fil a', false), ('popeyes', false),
  ('kfc', false), ('raising canes', false), ('zaxbys', false), ('wingstop', false),
  ('buffalo wild wings', false), ('sonic drive in', false), ('sonic', true), ('arbys', false),
  ('carls jr', false), ('jack in the box', false), ('five guys', false), ('in n out', false),
  ('culvers', false), ('freddys frozen custard', false), ('shake shack', false),
  ('whataburger', false), ('dairy queen', false), ('dq grill chill', false),
  ('baskin robbins', false), ('cold stone creamery', false), ('dunkin', false),
  ('krispy kreme', false), ('einstein bros bagels', false), ('ihop', false), ('dennys', false),
  ('waffle house', false), ('cracker barrel', false), ('applebees', false), ('chilis', false),
  ('olive garden', false), ('red lobster', false), ('outback steakhouse', false),
  ('texas roadhouse', false), ('red robin', false), ('bjs restaurant', false),
  ('cheesecake factory', false), ('pf changs', false), ('noodles company', false),
  ('noodles and company', false), ('jamba', false), ('smoothie king', false),
  ('tropical smoothie cafe', false), ('crumbl', false), ('nothing bundt cakes', false),
  ('insomnia cookies', false), ('7 eleven', false), ('7eleven', false), ('maverik', false),
  ('jacksons food stores', false), ('jacksons', true), ('chevron', true), ('shell', true),
  ('sinclair', true),
  -- auto
  ('jiffy lube', false), ('valvoline', false), ('take 5 oil change', false), ('take 5', true),
  ('grease monkey', false), ('oil can henrys', false), ('midas', true), ('midas auto', false),
  ('meineke', false), ('aamco', false), ('firestone', false), ('goodyear', false),
  ('les schwab', false), ('discount tire', false), ('big o tires', false), ('tires plus', false),
  ('ntb', false), ('national tire battery', false), ('pep boys', false), ('monro', true),
  ('mavis', true), ('tire discounters', false), ('point s', true),
  ('christian brothers automotive', false), ('tuffy', true), ('car x', false), ('carx', false),
  ('precision tune auto care', false), ('maaco', false), ('caliber collision', false),
  ('gerber collision', false), ('service king', false), ('crash champions', false),
  ('abra auto body', false), ('safelite', false), ('glass america', false), ('ziebart', false),
  ('mister car wash', false), ('mr car wash', false), ('quick quack', false),
  ('tommys express', false), ('autozone', false), ('o reilly auto parts', false),
  ('oreilly auto parts', false), ('napa auto parts', false), ('napa', true),
  ('advance auto parts', false), ('carmax', false), ('carvana', false),
  ('enterprise rent a car', false), ('hertz', true), ('avis', true), ('budget car rental', true),
  -- big box / retail
  ('walmart', false), ('target', true), ('costco', false), ('sams club', false),
  ('best buy', false), ('staples', true), ('office depot', false), ('fedex office', false),
  ('ups store', false), ('batteries plus', false), ('verizon', true), ('t mobile', false),
  ('at t', true), ('att', true), ('xfinity', false), ('spectrum', true), ('amazon', true),
  ('dollar tree', false), ('dollar general', false), ('family dollar', false),
  ('harbor freight', false), ('tractor supply', false), ('michaels', true), ('hobby lobby', false),
  ('joann', true), ('bed bath beyond', false), ('kohls', false), ('jcpenney', false),
  ('macys', false), ('marshalls', false), ('tj maxx', false), ('ross dress for less', false),
  ('ross', true), ('goodwill', true), ('salvation army', false)
) as t(brand, exact_only);

-- Rule evaluation per row. url_shape is the worker's heuristic approximated:
--   sub   locator subdomain
--   path  locator path segment
--   num   numeric store id segment (2–4 or 6 digits; a 5-digit number is a zip)
--   own   the registrable domain contains a strong (≥5-char, non-generic)
--         token of the name — "the business's own domain"
--   gmb   utm_campaign/utm_source=gmb|gbp (weak: only tips path+own)
create or replace temp view rfl04_rules as
with base as (
  select b.id, b.workspace_id, b.name, b.is_chain, b.chain_reason,
         b.google_place_id, b.website_url,
         coalesce(b.name_normalized, lower(b.name)) as nn,
         lower(coalesce(b.website_url, '')) as url,
         lower(regexp_replace(coalesce(b.website_url, ''), '^https?://(www\.)?([^/?#]+).*$', '\2')) as host
  from businesses b
),
parts as (
  select *,
    regexp_replace(host, '^([^.]+\.)*([^.]+)\.[^.]+$', '\2') as domain_label,
    regexp_replace(regexp_replace(url, '^https?://[^/]+', ''), '[?#].*$', '') as path
  from base
),
sig as (
  select *,
    host ~ '^(salons?|locations?|stores?|local|shops|clinics|offices|restaurants|centers|studios|gyms)\.[^.]+\.[^.]+' as sub,
    path ~ '(^|/)(stores?|locations?|l|nearme|near-me|store-locator|storelocator|locator|find-a-store|find-a-location)(/|$)' as locpath,
    path ~ '/[^/]+/.*(^|/|-|_)(\d{2,4}|\d{6})(/|$)' as num,
    url ~ 'utm_(campaign|source|medium)=(gmb|gbp|google[-_]?my[-_]?business|google[-_]?business[-_]?profile)(&|$)' as gmb,
    exists (
      -- mirrors lib/chains.ts domainSharesNameToken: a strong name token the
      -- domain contains (≥5 chars), or starts with (≥4 chars), or the domain
      -- is the squashed name
      select 1 from regexp_split_to_table(nn, ' ') tok
      where tok not in ('services','service','company','group','center','centers','clinic','salon','salons',
                        'studio','studios','store','stores','plumbing','plumber','plumbers','heating',
                        'cooling','electric','electrical','roofing','dental','dentistry','fitness',
                        'automotive','repair','beauty','barber','barbershop','pizza','grill','restaurant',
                        'boise','nampa','meridian','caldwell','eagle','idaho','home','care','auto','hair',
                        'nails','cafe','kuna','hvac')
        and (
          (length(tok) >= 5 and position(tok in domain_label) > 0)
          or (length(tok) >= 4 and position(tok in domain_label) = 1)
          or (length(domain_label) >= 4 and position(domain_label in replace(nn, ' ', '')) > 0)
        )
    ) as own
  from parts
),
brand as (
  select s.id,
         (select r.brand from rfl04_brands r
           where (not r.exact_only and (s.nn = r.brand or s.nn like r.brand || ' %'))
              or (r.exact_only and s.nn = r.brand)
           order by length(r.brand) desc limit 1) as matched_brand
  from sig s
),
multi as (
  select workspace_id, nn, count(distinct google_place_id) as places
  from base group by workspace_id, nn
)
select s.id, s.workspace_id, s.name, s.nn, s.website_url, s.is_chain, s.chain_reason,
       b.matched_brand,
       (s.sub or (not s.own and (s.locpath or s.num)) or (s.locpath and s.num) or (s.locpath and s.gmb)) as url_shape,
       m.places,
       case
         when b.matched_brand is not null then 'known_brand'
         when (s.sub or (not s.own and (s.locpath or s.num)) or (s.locpath and s.num) or (s.locpath and s.gmb)) then 'url_shape'
         when m.places >= 3 then 'multi_location'
       end as new_reason
from sig s
join brand b on b.id = s.id
join multi m on m.workspace_id = s.workspace_id and m.nn = s.nn;


-- ===========================================================================
-- PART 1 — preview (read-only): every row that would change
-- ===========================================================================

select name, website_url, is_chain as was_chain, chain_reason as old_reason,
       new_reason, matched_brand, places as same_name_places
from rfl04_rules
where new_reason is not null
  and (is_chain is distinct from true or chain_reason is null or chain_reason <> new_reason)
order by new_reason, name;

-- Counts by rule, and how many rows stay independent.
select new_reason, count(*) from rfl04_rules group by new_reason order by 1 nulls last;


-- ===========================================================================
-- PART 2 — apply (one transaction). Sets is_chain + chain_reason only.
-- ===========================================================================

begin;

update businesses b
set is_chain = true,
    chain_reason = r.new_reason
from rfl04_rules r
where r.id = b.id
  and r.new_reason is not null
  and (b.is_chain is distinct from true or b.chain_reason is null)
  -- local exceptions: exact names from PART 1 that are NOT chains
  and b.name not in ('')
returning b.name, b.website_url, b.chain_reason;

commit;


-- ===========================================================================
-- PART 3 — verify (read-only)
-- ===========================================================================

-- Every is_chain row now carries a reason (rows the worker marked before
-- 0008 and that no rule explains show null here — they keep is_chain).
select chain_reason, count(*) as businesses
from businesses where is_chain group by chain_reason order by 1 nulls last;

-- The audit's named offenders should all be chains now.
select name, is_chain, chain_reason, website_url
from businesses
where name ilike '%ulta%' or name ilike '%home depot%' or name ilike '%roto-rooter%'
   or name ilike '%great clips%' or name ilike '%sport clips%' or name ilike '%supercuts%'
   or name ilike '%smartstyle%'
order by name;
