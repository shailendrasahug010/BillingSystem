-- Selling price lists are called Price A / B / C. Businesses that still have
-- the three lists as first created (Retail, Wholesale, Distributor, none of
-- them renamed and no "Price A/B/C" of their own) get the new names; the
-- lists, their prices and the customers on them stay as they are.
UPDATE price_levels p
SET name = CASE p.name WHEN 'Retail' THEN 'Price A' WHEN 'Wholesale' THEN 'Price B' ELSE 'Price C' END,
    updated_at = now()
WHERE p.name IN ('Retail', 'Wholesale', 'Distributor')
  AND (SELECT count(*) FROM price_levels q WHERE q.business_id = p.business_id AND q.name IN ('Retail', 'Wholesale', 'Distributor')) = 3
  AND NOT EXISTS (SELECT 1 FROM price_levels q WHERE q.business_id = p.business_id AND q.name IN ('Price A', 'Price B', 'Price C'));
