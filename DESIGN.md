# Design System Documentation

## 1. Overview & Creative North Star

### Creative North Star: "The Command Core"
This design system moves away from the chaotic, cluttered aesthetic often found in gaming tools, opting instead for a "Command Core" philosophy. It treats the Minecraft server administrator as a high-level architect. The experience is rooted in **Structural Sophistication**: a blend of data-heavy utility and premium editorial layout. 

To break the "template" look, we employ intentional asymmetry—shifting high-density data modules against wide, breathable negative space. We avoid the rigid 12-column grid in favor of a layered, "stack-and-float" approach, where elements feel like high-precision instruments resting on a deep, obsidian-like canvas.

## 2. Colors

The palette is anchored in deep neutrals and a high-vibrancy "Mantine Green" that signifies life, uptime, and growth.

- **Primary & Signature Accents:** The `primary` (#54e98a) and `primary-container` (#2ECC71) are reserved for "Active" states and critical CTAs.
- **The "No-Line" Rule:** We do not use 1px solid borders to define sections. Layout boundaries must be established through background color shifts. For instance, a navigation rail using `surface-container-low` (#1C1B1B) sits directly against the `surface` (#131313) main content area.
- **Surface Hierarchy & Nesting:** Treat the UI as physical layers. 
    - **Base:** `surface` (#131313)
    - **In-Page Sections:** `surface-container-low` (#1C1B1B)
    - **Actionable Cards:** `surface-container` (#201F1F)
    - **Interaction/Pop-overs:** `surface-container-high` (#2A2A2A)
- **The "Glass & Gradient" Rule:** To achieve a premium "gamer-pro" feel, use Glassmorphism for floating overlays. Apply a 12px `backdrop-blur` to surfaces using 80% opacity of the `surface-container-highest` token.
- **Signature Textures:** For primary action buttons, apply a subtle linear gradient (135deg) from `primary-fixed` (#6BFE9C) to `primary-container` (#2ECC71) to provide depth that flat colors cannot achieve.

## 3. Typography

The system utilizes **Inter** to maintain a modern, technical, and highly legible interface.

- **Data as Art:** Use `display-md` or `headline-lg` for primary metrics (e.g., player counts, RAM usage). The large scale turns raw data into a visual focal point.
- **Editorial Hierarchy:**
    - **Headlines:** `headline-sm` (#1.5rem) provides an authoritative anchor for page titles.
    - **Body:** `body-md` (0.875rem) handles the bulk of server logs and settings, providing a clean, technical density.
    - **Labels:** `label-md` (0.75rem) in `on-surface-variant` (#BBCBBB) should be used for metadata to keep the interface from feeling overcrowded.

## 4. Elevation & Depth

We eschew traditional drop shadows for **Tonal Layering**, creating a sense of "lift" through color value alone.

- **The Layering Principle:** Depth is achieved by "stacking" container tiers. A card using `surface-container-highest` placed on a `surface-container-low` background creates a natural, soft elevation.
- **Ambient Shadows:** When a floating element (like a context menu) is required, use a shadow with a blur of 32px and 6% opacity. The shadow color must be a tinted version of `surface-container-lowest` (#0E0E0E) to ensure it feels like part of the environment.
- **The "Ghost Border" Fallback:** If a container requires further definition for accessibility, use a "Ghost Border." This is the `outline-variant` (#3D4A3E) token set to 15% opacity. High-contrast, 100% opaque borders are strictly forbidden.
- **Frosted Integration:** Use backdrop blurs on any surface that "floats" above content. This allows the vibrant green of the primary accents to bleed through the dark containers, softening the UI.

## 5. Components

### Buttons
- **Primary:** Rounded `md` (0.75rem). Gradient background (Primary to Primary-Container). Text color: `on-primary` (#003919).
- **Secondary/Ghost:** No background. `outline-variant` at 20% opacity for the border. Text: `primary` (#54E98A).

### Chips (Server Status)
- Use `primary-container` for "Running" and `error-container` for "Stopped."
- Chips should use the `full` (9999px) roundedness to contrast against the `md` roundedness of the main layout.

### Input Fields
- Background: `surface-container-lowest` (#0E0E0E).
- Border: "Ghost Border" (15% opacity `outline-variant`).
- Focus State: Border opacity increases to 100% `primary`.

### Cards & Lists
- **Strictly No Dividers:** Use vertical spacing scale `6` (1.5rem) to separate list items. 
- Use a background shift to `surface-container-high` on hover to indicate interactivity.

### Terminal / Console Module
- A specialized component using `surface-container-lowest` with a "Ghost Border." 
- Use `body-sm` with a monospace fallback for logs to maximize information density while maintaining the "Command Core" aesthetic.

## 6. Do's and Don'ts

### Do
- **Do** use `primary-fixed-dim` for icons to give them a subtle, professional glow.
- **Do** utilize the `Spacing 12` and `16` values to create "Editorial Breathing Room" between major dashboard modules.
- **Do** ensure all interactive elements use the `md` (0.75rem) corner radius for a cohesive, friendly yet professional feel.

### Don't
- **Don't** use pure white (#FFFFFF) for text. Use `on-surface` (#E5E2E1) to reduce eye strain in the dark environment.
- **Don't** use 1px solid borders for layout containers. Depend on background color shifts.
- **Don't** use standard "drop shadows" on cards; stick to Tonal Layering for a cleaner, modern finish.
- **Don't** crowd the interface. If a screen feels busy, increase the spacing scale rather than adding lines or dividers.