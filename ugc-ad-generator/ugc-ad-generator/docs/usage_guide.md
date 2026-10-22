# Usage Guide: Running the Prompts by Hand

You do not need the web app to use this system. Each file in `/prompts` contains one ready-to-use prompt with `{variables}` in curly braces. Paste it into Claude (or any capable chat model) after filling the variables in.

## Order

```
01_hook_generator.md          -> pick your favorite hook
        |
02_script_generator.md        -> base script
        |
        +--> 03_platform_adapter.md
        +--> 05_ab_variation_generator.md
04_cta_caption_generator.md   -> runs from the brand details; no script needed
```

## Variables

| Variable | Used in stages | Example |
|---|---|---|
| `{brand_name}` | 1 to 5 | PureGlow |
| `{product}` | 1 to 5 | Vitamin C Brightening Serum |
| `{target_audience}` | 1, 2, 4, 5 | Women 22-35, urban India |
| `{key_benefit_or_transformation}` | 1, 2, 4 | Visibly brighter skin in about 2 weeks |
| `{tone}` | 1, 2 | Honest, slightly skeptical turned believer |
| `{proof_point}` | 2 | 10% stabilized Vitamin C |
| `{chosen_hook}` | 2 | The hook you picked from stage 1 |
| `{base_script}` | 3, 5 | The full output of stage 2 |
| `{offer_or_link}` | 4 | 20% off first order, link in bio (or "No active offer") |

## Quality checklist before sending to a client

- [ ] No invented statistics, clinical claims, or timeframes the brand has not confirmed
- [ ] No made-up discount codes or prices
- [ ] Every script reads naturally out loud
- [ ] Platform versions genuinely differ in pacing, not just wording
- [ ] Hashtags mix broad, mid-size, and niche tags
