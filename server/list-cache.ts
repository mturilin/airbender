// server/list-cache.ts — keeping an answer while nothing has changed.
//
// What: a small cache for one expensive read per key (here: a repository's
// issue list). It gives the kept answer out again while a cheap stamp says
// nothing changed, joins requests that arrive while a read is under way,
// and forgets at once when told the answer is stale.
//
// Why: every read of the issues starts a beads program that opens the
// whole database, about 0.45 s, and beads lets one run at a time. On
// switching between repositories the tab asked for the list three times at
// once and the setup check a fourth: 2.4 s, more while a sync ran. The
// user: "it takes a few seconds to reload ... It's pretty inconvenient"
// (bead-bb-3pr).
//
// Design notes:
// - Three things must hold for a kept answer to be given out: the stamp is
//   unchanged, nobody marked it stale, and it is not older than the limit.
//   The stamp covers changes made outside (an agent, a terminal); the mark
//   covers the caller's own writes, at once; the age covers what the stamp
//   misses (for beads: a delete, and a sync run by hand).
// - A read that was under way when the answer was marked stale may have
//   read the old state. Its answer is given to those who asked before the
//   mark, and is neither kept nor given to anyone asking after it.
// - Knows nothing of beads or of the plugin: the stamp and the read are
//   handed in. That is what lets it be tested without either.
//
// Gotchas:
// - An answer the caller says not to keep (a failed read) is never kept:
//   the next request reads again.

/** What is kept for one key. */
interface Kept<T> {
  value: T;
  /** The stamp taken just before the read that produced the value. */
  stamp: string | null;
  at: number;
}

/**
 * Builds a cache.
 *
 * @param stampOf A cheap sign of the key's state that changes whenever the
 *   answer may have; null when it cannot be told (a kept answer then
 *   stands only on the mark and the age).
 * @param maxAgeMs A kept answer older than this is read again.
 * @param keep Whether an answer is worth keeping (a failure is not).
 * @returns `read` and `stale`.
 */
export function createListCache<T>({
  stampOf,
  maxAgeMs,
  keep,
  now = Date.now,
}: {
  stampOf: (key: string) => string | null;
  maxAgeMs: number;
  keep: (value: T) => boolean;
  now?: () => number;
}) {
  const kept = new Map<string, Kept<T>>();
  /** Reads under way, with the generation they started in. */
  const under = new Map<string, { generation: number; answer: Promise<T> }>();
  /** Counts the times a key was marked stale. */
  const generations = new Map<string, number>();
  const generationOf = (key: string) => generations.get(key) ?? 0;

  return {
    /**
     * The answer for a key: the kept one while it stands, else a read.
     *
     * @param load Does the real read; called at most once per call here,
     *   and not at all when a kept answer stands or a read is under way.
     * @param fresh Do not give out a kept answer: read (or join a read
     *   that started after the last stale mark).
     */
    async read(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
      const generation = generationOf(key);
      const have = kept.get(key);
      if (
        !fresh &&
        have !== undefined &&
        now() - have.at <= maxAgeMs &&
        have.stamp === stampOf(key)
      ) {
        return have.value;
      }
      const running = under.get(key);
      if (running !== undefined && running.generation === generation) {
        return running.answer;
      }
      // Taken before the read: a change made while it runs then shows as a
      // different stamp at the next request.
      const stamp = stampOf(key);
      const answer = load().then(
        (value) => {
          if (under.get(key)?.answer === answer) under.delete(key);
          if (generationOf(key) === generation && keep(value)) {
            kept.set(key, { value, stamp, at: now() });
          }
          return value;
        },
        (cause: unknown) => {
          if (under.get(key)?.answer === answer) under.delete(key);
          throw cause;
        },
      );
      under.set(key, { generation, answer });
      return answer;
    },

    /**
     * The answer for a key may have changed: forget it. A read under way
     * is no longer joined by later requests, and its answer is not kept.
     */
    stale(key: string): void {
      kept.delete(key);
      generations.set(key, generationOf(key) + 1);
    },
  };
}
