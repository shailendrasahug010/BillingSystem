-- "Strip" (tablets, sachets, pouches sold in strips) as a unit for every
-- existing business; new businesses get it from the seed. GST has no UQC for
-- strips, so returns report them as OTH (others).
INSERT INTO units (business_id, name, symbol, uqc, decimals)
SELECT b.id, 'Strip', 'STRIP', 'OTH', 0 FROM businesses b
ON CONFLICT (business_id, symbol) DO NOTHING;
