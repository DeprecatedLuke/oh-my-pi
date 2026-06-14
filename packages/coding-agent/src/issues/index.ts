/**
 * Project-local issue tracker.
 *
 * Issues live under `<cwd>/.omp/issues/<category>/<id>-<slug>.md` (and
 * `<cwd>/.omp/issues/.archive/<category>/<id>-<slug>.md` once archived).
 * The id is global across categories and stable across archive/unarchive.
 */
export * from "./store";
