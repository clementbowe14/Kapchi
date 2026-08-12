update customization_sets
set label = case kind
  when 'text_short' then 'Text (short)'
  when 'text_long' then 'Text (long)'
  when 'text_image' then 'Text (long) and Image'
  when 'text_image_trim' then 'Text (long) + Image + Trim'
  else label
end
where kind in ('text_short', 'text_long', 'text_image', 'text_image_trim');
