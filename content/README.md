# Content

Missions, and the strings they reference. Authored here, validated by
`npm run content:validate`, published by `npm run content:publish`.

```
content/
  missions/congklak/*.yaml    the 20-mission ladder
  missions/benteng/*.yaml     the 12-mission ladder
  strings/id.yaml             Indonesian — the source locale
  strings/en.yaml             English — allowed to lag
```

## Editing a mission

```bash
npm run content:validate congklak     # everything, including the solver
npm run content:validate -- --fast    # schema and strings only, no search
```

Validation is not advisory. It refuses:

| Check | Why it exists |
|---|---|
| Weights sum to 1.0, exactly one node ≥ 0.4 | A mission that teaches "a bit of everything" produces evidence about nothing |
| Rationale names a mechanic | A mission may not claim a skill because its artwork mentions it |
| Ladder ranks contiguous from 1 | A gap silently stops the selector unlocking anything past it |
| Solvable | A mission nobody can win is broken, not hard |
| Declared rating within 200 of play | So the adaptive engine is not handed a number someone guessed |
| ≥ ⅓ of Congklak missions are greedy traps | The quota is the mechanism behind `algo.greedy`; without it, it erodes silently |
| Every referenced string exists in `id.yaml` | A missing key renders as the key |

## Rank and rating are different axes

**Rank** is the pedagogical order. It drives unlocking, and it is contiguous.

**Rating** is how hard the mission plays. It drives difficulty matching in the
adaptive engine, and it is *not* required to increase with rank.

They come apart on purpose. `congklak.m12` asks the student to find the largest
capture available — conceptually well past `m04`'s wrap-around counting — but a
player pressing pits at random stumbles into it more often, so its rating is
lower. Forcing the ratings to march upward with rank would make the engine hand
struggling students missions it believes are easy and they find impossible.

Ratings here are seeds. They are retuned from real attempts once a pilot has
produced data, and the authored value only has to be close enough that the first
cohort is not mismatched.

## Why the difficulty check sometimes says nothing

The estimator plays each mission a few hundred times choosing uniformly at
random. That is a fair proxy for missions won by *choosing well*, and a useless
one for missions won by *computing correctly*: a mission with one legal move is
beaten by a random player every time and by a confused student every time.

So the check is skipped below an average of two real choices per turn, and the
validator says so rather than emitting a number it cannot stand behind.

## Publishing

```bash
npm run content:publish              # writes a draft version
npm run content:publish -- --promote # and makes it current
```

The version identifier is a hash of the content, so republishing unchanged
content is a no-op rather than a new row that looks like a change nobody made.
Rollback is promoting a previous version; the database enforces that exactly one
version is current, so there is no window with none.

`checks.answers` is published but never served to a client — course checks are
graded server-side, and shipping the answer key to the device would make the
check evidence of nothing.
