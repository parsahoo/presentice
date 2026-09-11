# Design

A quiet rehearsal booth. The slide is the stage, the script reads like a teleprompter strip, and the controls stay out of the way. It refuses the SaaS dashboard look: no cards of icons, no gradients, no decorative color.

## Color

Restrained. Cool graphite neutrals (`css/app.css` tokens `--bg`, `--panel`, `--panel-2`, `--line`, `--line-2`, `--ink`, `--muted`, mapped to the working tokens `--surface`, `--sunken`, `--hover`, `--line-strong`, `--ink-2`, `--ink-3`).

Dark is the default, whatever the system setting: `--bg #0d0f13`, `--panel #12151b`, `--panel-2 #171b22`, `--line #232a33`, `--line-2 #3a4552`, `--ink #e8ecf1`, `--muted #9aa4b1`. A light theme sits behind the sun and moon button in every header; the choice is kept in `localStorage` as `presentice:theme`. `js/theme.js` runs in the head so the page never flashes the wrong theme. Text keeps AA contrast in both themes.

Presenter colors are the only hues in the interface (`--p0` amber `#f5a623`, `--p1` blue `#5aa9e6`, `--p2` green `#4cc463`, then `--p3` to `--p5`, applied through `.pc-N` classes that set `--pc`). They mark who speaks: a dot, a chip tint, the tint behind the current sentence, the word highlight and the shadow-gap bar. Speaker names stay in ink, never in the presenter color, so text contrast never depends on hue.

Primary actions and pressed toggles are filled with ink, not with a brand color.

## Type

One system sans stack for everything. UI text is 13 to 15 px. The transcript is the one large reading size (21 px, line height 1.6, max 34em) because it is read aloud from a distance. Numbers in counters use tabular figures.

## Shape and depth

8 px radius on controls, 10 to 14 px on panels. Borders are 1 px hairlines. The only real shadow sits under the slide on the stage and under popovers.

## Motion

State only, 150 to 250 ms with an exponential ease-out. The signature moment is the shadow gap: an underline in the presenter color drains under the sentence for exactly the pause length while you say it back. Reduced motion keeps the bar static.

## Components

Buttons (`.btn`, `.primary`, `.ghost`, `.small`), segmented groups of toggle buttons (`.segmented` + `.seg[aria-pressed]`), toggles (`.toggle[aria-pressed]`), transport buttons (`.tbtn`). Segmented groups use buttons, not radios, so arrow keys keep driving playback.

Every control has a visible focus ring (2 px ink outline, 2 px offset).
