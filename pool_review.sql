-- Pool Review tab: bid review for a client's property list.
-- Applies on top of the inspection schema (inspections, inspection_photos, inspection-photos bucket).

-- 1. Properties being reviewed (one row per property on a client's list)
create table if not exists public.pool_review_properties (
  id          text primary key,
  client      text not null default 'NRP Group',
  name        text not null,
  address     text,
  city        text,
  region      text,
  website     text,
  manager     text,
  phone       text,
  exam_days   text,
  techs       text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
comment on table public.pool_review_properties is 'Properties on a client bid list, shown in the Pool Review tab.';

-- 2. The review itself: one row per property, edited by any staff member
create table if not exists public.pool_reviews (
  property_id        text primary key references public.pool_review_properties(id) on delete cascade,
  inspection_id      uuid references public.inspections(id) on delete set null,
  poolbrain_url      text,
  category           smallint check (category between 0 and 5),
  inspection_result  text check (inspection_result in ('fail','at_risk','pass')),
  summary            text,
  price_3x           numeric(10,2),
  price_2x           numeric(10,2),
  repairs            text,
  renovations        text,
  maintenance        text,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id) default auth.uid(),
  updated_by_email   text
);
comment on table public.pool_reviews is 'Pool Review tab: category, result, pricing and needed work per property. inspection_id null = use the latest inspection matching the property name.';

-- 3. Photos added during review (files live in the inspection-photos bucket under reviews/<property_id>/)
create table if not exists public.pool_review_photos (
  id                 uuid primary key default gen_random_uuid(),
  property_id        text not null references public.pool_review_properties(id) on delete cascade,
  created_at         timestamptz not null default now(),
  uploaded_by        uuid references auth.users(id) default auth.uid(),
  uploaded_by_email  text,
  category_key       text not null default 'additional',
  caption            text,
  file_name          text,
  storage_path       text not null unique,
  mime_type          text,
  size_bytes         bigint
);
create index if not exists pool_review_photos_property_idx on public.pool_review_photos(property_id);

-- keep updated_at / updated_by current on every edit
create or replace function public.pool_reviews_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists pool_reviews_touch on public.pool_reviews;
create trigger pool_reviews_touch before update on public.pool_reviews
  for each row execute function public.pool_reviews_touch();

-- Row Level Security: signed-in staff read and edit everything in the review
alter table public.pool_review_properties enable row level security;
alter table public.pool_reviews enable row level security;
alter table public.pool_review_photos enable row level security;

drop policy if exists "staff read review properties" on public.pool_review_properties;
create policy "staff read review properties" on public.pool_review_properties
  for select to authenticated using (true);

drop policy if exists "staff read reviews" on public.pool_reviews;
create policy "staff read reviews" on public.pool_reviews for select to authenticated using (true);
drop policy if exists "staff add reviews" on public.pool_reviews;
create policy "staff add reviews" on public.pool_reviews for insert to authenticated with check (true);
drop policy if exists "staff edit reviews" on public.pool_reviews;
create policy "staff edit reviews" on public.pool_reviews for update to authenticated using (true) with check (true);

drop policy if exists "staff read review photos" on public.pool_review_photos;
create policy "staff read review photos" on public.pool_review_photos for select to authenticated using (true);
drop policy if exists "staff add review photos" on public.pool_review_photos;
create policy "staff add review photos" on public.pool_review_photos for insert to authenticated with check (true);
drop policy if exists "staff edit review photos" on public.pool_review_photos;
create policy "staff edit review photos" on public.pool_review_photos for update to authenticated using (true) with check (true);
drop policy if exists "staff delete review photos" on public.pool_review_photos;
create policy "staff delete review photos" on public.pool_review_photos for delete to authenticated using (true);

-- any staff member can delete review photo files (inspection photos stay owner-only)
drop policy if exists "staff delete review photo files" on storage.objects;
create policy "staff delete review photo files" on storage.objects
  for delete to authenticated using (bucket_id = 'inspection-photos' and name like 'reviews/%');

-- live updates so several people can review at once
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.pool_reviews; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.pool_review_photos; exception when duplicate_object then null; end;
  end if;
end $$;

-- 4. NRP Group property list (due October 2, 2026)
insert into public.pool_review_properties
  (id, client, name, address, city, region, website, manager, phone, exam_days, techs, sort_order)
values
  ('the-porter-apartments', 'NRP Group', 'The Porter Apartments', '6101 Ross Rd, Del Valle, TX 78617', 'Del Valle', 'Austin', 'https://theporteratx.com/', 'Ruby Lopez', '512-996-6606', 'Tue / Wed', 'Zak / Hunter', 1),
  ('residences-at-decker', 'NRP Group', 'Residences at Decker', '9000 Decker Ln, Austin, TX 78724', 'Austin', 'Austin', 'https://www.residencesdeckeraustin.com/', 'Lindsey Slabaugh', '737-701-5500', 'Tue / Wed', 'Zak / Hunter', 2),
  ('the-beckett', 'NRP Group', 'The Beckett', '14011 FM 969, Austin, TX 78724', 'Austin', 'Austin', 'https://www.beckettaustin.com/', 'Daniel Soto', '512-354-1930', 'Tue / Wed', 'Zak / Hunter', 3),
  ('bridge-at-estancia', 'NRP Group', 'Bridge at Estancia', '1100 Avenida Mercado St, Manchaca, TX 78652', 'Manchaca', 'Austin', 'https://www.bridgeestancia.com/', 'Celeste Rosa', '737-301-1303', 'Tue / Wed', 'Zak / Hunter', 4),
  ('the-james-on-grand-avenue', 'NRP Group', 'The James on Grand Avenue', '15701 Farm to Market Rd 1325 #3101, Austin, TX 78728', 'Austin', 'Austin', 'https://www.jamesgrandave.com/', 'Maria Martinez', '737-270-8159', 'Tue / Wed', 'Zak / Hunter', 5),
  ('the-bridge-at-harris-ridge', 'NRP Group', 'The Bridge at Harris Ridge', '1501 E Howard Ln, Austin, TX 78753', 'Austin', 'Austin', 'https://www.bridgeharrisridge.com/', 'Yvonne Maguire', '512-271-5677', 'Tue / Wed', 'Zak / Hunter', 6),
  ('revolve', 'NRP Group', 'Revolve', '112 Will Davis Dr, Austin, TX 78752', 'Austin', 'Austin', 'https://revolveatx.com/', 'Tray Cole', '737-279-8918', 'Tue / Wed', 'Zak / Hunter', 7),
  ('bridge-at-loyola', 'NRP Group', 'Bridge at Loyola', '6400 Loyola Ln, Austin, TX 78724', 'Austin', 'Austin', 'https://www.bridgeloyola.com/', 'Matilda Selvera', '512-640-6020', 'Tue / Wed', 'Zak / Hunter', 8),
  ('azulina-at-decker-lake', 'NRP Group', 'Azulina at Decker Lake', '8705 Decker Lake Rd, Austin, TX 78724', 'Austin', 'Austin', 'https://azulinaapts.com/', 'Maricela Gonzales', '512-686-8606', 'Tue / Wed', 'Zak / Hunter', 9),
  ('the-markson-austin', 'NRP Group', 'The Markson Austin', '5313 Vega Ave, Austin, TX 78735', 'Austin', 'Austin', 'https://marksonaustin.com/', 'Ashley Villareal', '737-279-8898', 'Tue / Wed', 'Zak / Hunter', 10),
  ('the-element', 'NRP Group', 'The Element', '5724 E Howard Ln, Manor, TX 78653', 'Manor', 'Austin', 'https://www.elementaptsaustin.com/', 'Larisa Manin', '737-270-8054', 'Tue / Wed', 'Zak / Hunter', 11),
  ('terrace-at-walnut-creek', 'NRP Group', 'Terrace at Walnut Creek', '8712 Old Manor Rd, Austin, TX 78724', 'Austin', 'Austin', 'https://www.terracewalnutcreek.com/', 'Kimberly Cannon', '512-646-6005', 'Tue / Wed', 'Zak / Hunter', 12),
  ('carrington-at-oak-hill', 'NRP Group', 'Carrington at Oak Hill', '5711 Vega Ave, Austin, TX 78735', 'Austin', 'Austin', 'https://carringtonatoakhill.com/', 'Open Position', '737-263-5111', 'Tue / Wed', 'Zak / Hunter', 13),
  ('centro35', 'NRP Group', 'Centro35', '508 Labrador Blvd, San Marcos, TX 78666', 'San Marcos', 'Austin', 'https://www.centro35.com/', 'Felicia Houle', '512-546-7513', 'Tues / Thursday', 'Izaiah / Drew', 14),
  ('3700-dacy', 'NRP Group', '3700 Dacy', '3700 Dacy Ln, Kyle, TX 78640', 'Kyle', 'Austin', 'https://www.3700dacy.com/', 'Brianna Jimenez', '512-523-6655', 'Tues / Thursday', 'Izaiah / Drew', 15),
  ('landings-at-marine-creek', 'NRP Group', 'Landings at Marine Creek', '4109 Lanyard Dr #6306, Fort Worth, TX 76106', 'Fort Worth', 'Dallas / Fort Worth', null, 'TaSheba Judie', '817-349-9170', 'Thur / Fri', 'Zak / D''andre', 16),
  ('2900-broadmoor', 'NRP Group', '2900 Broadmoor', '2900 Broadmoor Dr, Fort Worth, TX 76116', 'Fort Worth', 'Dallas / Fort Worth', 'https://www.2900broadmoor.com/', 'Shannon Page', '817-769-4677', 'Thur / Fri', 'Zak / D''andre', 17),
  ('sterlingshire', 'NRP Group', 'Sterlingshire', '9415 Bruton Rd, Dallas, TX 75217', 'Dallas', 'Dallas / Fort Worth', 'https://www.sterlingshire.com/', 'Amber Bottley', '469-778-9050', 'Thur / Fri', 'Zak / D''andre', 18),
  ('the-veranda', 'NRP Group', 'The Veranda', '2420 E McKinney St, Denton, TX 76209', 'Denton', 'Dallas / Fort Worth', 'https://www.livetheveranda.com/', 'Latischa Emerson', '940-312-5955', 'Thur / Fri', 'Zak / D''andre', 19),
  ('the-whitley', 'NRP Group', 'The Whitley', '596 N Beauchamp Blvd, Princeton, TX 75407', 'Princeton', 'Dallas / Fort Worth', 'https://whitleyprinceton.com/', 'Davina Smith', '469-333-1943', 'Thur / Fri', 'Zak / D''andre', 20),
  ('the-independence', 'NRP Group', 'The Independence', '2150 Collin McKinney Pkwy, McKinney, TX 75070', 'McKinney', 'Dallas / Fort Worth', 'https://www.theindependencemckinney.com/', 'Mia Jones', '469-907-2040', 'Thur / Fri', 'Zak / D''andre', 21),
  ('mercantile-square', 'NRP Group', 'Mercantile Square', '3600 Tanacross Dr, Fort Worth, TX 76137', 'Fort Worth', 'Dallas / Fort Worth', 'https://www.livemercantilesquare.com/', 'Crystal Anthony', '682-224-8777', 'Thur / Fri', 'Zak / D''andre', 22),
  ('cora', 'NRP Group', 'Cora', '900 South Buddy Hayes Blvd, Anna, TX 75409', 'Anna', 'Dallas / Fort Worth', 'https://liveatcora.com/', 'Brittany Fuqua', '469-635-2910', 'Thur / Fri', 'Zak / D''andre', 23),
  ('the-elliott', 'NRP Group', 'The Elliott', '7851 S Collins St, Arlington, TX 76002', 'Arlington', 'Dallas / Fort Worth', 'https://www.elliottsenior.com/', 'Desi Williams', '817-405-3460', 'Thur / Fri', 'Zak / D''andre', 24),
  ('sutton-flats', 'NRP Group', 'Sutton Flats', '10001 Cedar Creek Dr, Sherman, TX 75090', 'Sherman', 'Dallas / Fort Worth', 'https://suttonflats.com/', 'Stephanie Turk', '903-998-2838', 'Thur / Fri', 'Zak / D''andre', 25),
  ('the-fielder-apartments', 'NRP Group', 'The Fielder Apartments', '1300 Wooded Lake Dr, Mesquite, TX 75150', 'Mesquite', 'Dallas / Fort Worth', 'https://www.thefielderapts.com/', 'Meshay Roney', '214-851-1447', 'Thur / Fri', 'Zak / D''andre', 26),
  ('the-pointe-at-bayou-bend', 'NRP Group', 'The Pointe at Bayou Bend', '800 Middle St, Houston, TX 77003', 'Houston', 'Houston', null, 'Tanesha Wilson', '713-646-1157', 'Tues', 'Montana / Jose / Paulino', 27),
  ('the-exchange', 'NRP Group', 'The Exchange', '1250 Leona St, Houston, TX 77009', 'Houston', 'Houston', 'https://theexchangehouston.com/', 'Emoname Gardner', '281-404-3574', 'Tues', 'Montana / Jose / Paulino', 28),
  ('gristmill-at-tuscany-park', 'NRP Group', 'Gristmill at Tuscany Park', '21821 S Post Oak Blvd, Fresno, TX 77545', 'Fresno', 'Houston', 'https://www.gristmilltuscanypark.com/', 'Sandra Hernandez', '281-915-1515', 'Tues', 'Montana / Jose / Paulino', 29),
  ('lumen', 'NRP Group', 'Lumen', '2400 W Dallas St, Houston, TX 77019', 'Houston', 'Houston', 'https://lumenhtx.com/', 'Salestria Robertson', '346-440-1515', 'Tues', 'Montana / Jose / Paulino', 30),
  ('the-parkline', 'NRP Group', 'The Parkline', '16717 Westpark Dr, Houston, TX 77083', 'Houston', 'Houston', 'https://parklineapts.com/', 'Timberlyn Platenburg', '281-406-3717', 'Tues', 'Montana / Jose / Paulino', 31),
  ('aviator-1518', 'NRP Group', 'Aviator 1518', '9120 FM1518, Schertz, TX 78154', 'Schertz', 'San Antonio', null, 'Adriana Contreras', '210-729-9087', 'Tues / Thursday', 'Izaiah / Drew', 32),
  ('the-arcadian', 'NRP Group', 'The Arcadian', '4611 E Loop 1604 N, Converse, TX 78109', 'Converse', 'San Antonio', 'https://www.arcadiansanantonio.com/', 'Arturo Yaniz', '210-728-4600', 'Tues / Thursday', 'Izaiah / Drew', 33),
  ('lucero', 'NRP Group', 'Lucero', '527 S Acme Rd, San Antonio, TX 78237', 'San Antonio', 'San Antonio', 'https://www.lucerosanantonio.com/', 'Sheena Dalmeida', '210-640-3559', 'Tues / Thursday', 'Izaiah / Drew', 34),
  ('balcones-lofts', 'NRP Group', 'Balcones Lofts', '3230 Hillcrest Dr, Balcones Heights, TX 78201', 'Balcones Heights', 'San Antonio', 'https://www.balconeslofts.com/', 'Jesse Moya', '210-399-2270', 'Tues / Thursday', 'Izaiah / Drew', 35),
  ('seven07-lofts', 'NRP Group', 'Seven07 Lofts', '707 SE Loop 410 Acc Rd, San Antonio, TX 78220', 'San Antonio', 'San Antonio', 'https://www.seven07lofts.com/', 'Jason Gonzales', '726-207-4205', 'Tues / Thursday', 'Izaiah / Drew', 36),
  ('juniper-s-edge', 'NRP Group', 'Juniper''s Edge', '8401 FM1560, San Antonio, TX 78254', 'San Antonio', 'San Antonio', 'https://www.junipersedge.com/', 'Delia Arreguin', '210-996-2075', 'Tues / Thursday', 'Izaiah / Drew', 37),
  ('emerald-village', 'NRP Group', 'Emerald Village', '3203 N Loop 1604 E, San Antonio, TX 78259', 'San Antonio', 'San Antonio', 'https://www.emeraldvillageapts.com/', 'Desirae Sanchez', '210-774-5800', 'Tues / Thursday', 'Izaiah / Drew', 38),
  ('elevate-at-kitty-hawk', 'NRP Group', 'Elevate at Kitty Hawk', '7347 Kitty Hawk Rd, Converse, TX 78109', 'Converse', 'San Antonio', 'https://www.elevatekittyhawkapts.com/', 'Christina Langille', '726-610-3696', 'Tues / Thursday', 'Izaiah / Drew', 39),
  ('the-stella', 'NRP Group', 'The Stella', '4835 Lord Rd, San Antonio, TX 78220', 'San Antonio', 'San Antonio', 'https://www.stellasanantonio.com/', 'Veronica Camocho', '210-774-4855', 'Tues / Thursday', 'Izaiah / Drew', 40),
  ('the-esther-apartments', 'NRP Group', 'The Esther Apartments', '2187 Schuwirth Rd, Converse, TX 78109', 'Converse', 'San Antonio', 'https://www.livetheesther.com/', 'Klarissa Garcia', '210-802-0266', 'Tues / Thursday', 'Izaiah / Drew', 41),
  ('esperanza-at-palo-alto', 'NRP Group', 'Esperanza at Palo Alto', '12305 SW Loop 410, San Antonio, TX 78224', 'San Antonio', 'San Antonio', 'https://www.esperanzapaloalto.com/', 'Alma Palma', '210-971-6900', 'Tues / Thursday', 'Izaiah / Drew', 42),
  ('the-scott-at-medio-creek', 'NRP Group', 'The Scott at Medio Creek', '9130 Excellence Dr, San Antonio, TX 78252', 'San Antonio', 'San Antonio', 'https://www.scottmediocreek.com/', 'Sandra Garcia', '726-222-9900', 'Tues / Thursday', 'Izaiah / Drew', 43),
  ('los-arcos-at-vida', 'NRP Group', 'Los Arcos at Vida', '10210 S Zarzamora St, San Antonio, TX 78224', 'San Antonio', 'San Antonio', 'https://www.losarcosvida.com/', 'Regina Walla', '210-465-1681', 'Tues / Thursday', 'Izaiah / Drew', 44),
  ('frontera-crossing', 'NRP Group', 'Frontera Crossing', '13139 Watson Rd, Von Ormy, TX 78073', 'Von Ormy', 'San Antonio', 'https://www.fronteracrossingapts.com/', 'Carol Benevides', '726-207-4051', 'Tues / Thursday', 'Izaiah / Drew', 45),
  ('acero', 'NRP Group', 'Acero', '333 W Cevallos, San Antonio, TX 78204', 'San Antonio', 'San Antonio', 'https://acerosouthtown.com/', 'Irene Miranda', '210-905-4805', 'Tues / Thursday', 'Izaiah / Drew', 46),
  ('artana-at-brooks', 'NRP Group', 'Artana at Brooks', '3838 Goliad Rd, San Antonio, TX 78223', 'San Antonio', 'San Antonio', 'https://artanabrooks.com/', 'Gina Lara', '210-202-4287', 'Tues / Thursday', 'Izaiah / Drew', 47)
on conflict (id) do update set
  client = excluded.client, name = excluded.name, address = excluded.address, city = excluded.city,
  region = excluded.region, website = excluded.website, manager = excluded.manager, phone = excluded.phone,
  exam_days = excluded.exam_days, techs = excluded.techs, sort_order = excluded.sort_order;
