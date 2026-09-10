/**
 * The one place the product is named. See `docs/brand.md` for the full brief.
 *
 * `name` is what the app calls itself on its own screens; `full` is what it is called
 * wherever the family is the context (title tag, manifest, footer, share text). A rename
 * is an edit here plus the two asset files under `public/brand/`.
 *
 * Note the two names that deliberately do NOT read from this: the IndexedDB name
 * ('local-transcribe', db.ts) and the shell cache prefix ('lt-shell-', sw.js). Renaming
 * either orphans the transcripts and models already on a user's device.
 */
export const BRAND = {
  name: 'Scribe',
  family: 'BearLog',
  full: 'Scribe by BearLog',
  host: 'scribe.bearlog.app',
  email: 'support@bearlog.app',
  legalName: 'BearLog Software Development Services',
  coffee: 'https://buymeacoffee.com/phaxz10',
  /** The family's front door, linked once from the Landing screen. */
  familyUrl: 'https://www.bearlog.app',
} as const
