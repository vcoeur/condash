// The pre-search tips panel for the search modal (invariant 12) — shown while
// the query is below the minimum length, in place of the result list.

/** Static how-to-search tips shown before a query is long enough to run. */
export function SearchTips() {
  return (
    <div class="search-tips">
      <h4>Tips</h4>
      <ul>
        <li>
          Multiple words act as <strong>AND</strong> — files must contain every word.
        </li>
        <li>
          Quote a phrase to keep words together: <code>"force stop"</code>.
        </li>
        <li>
          Searches READMEs <strong>and</strong> their <code>notes/</code> files. Slugs / paths match
          too — try a date prefix.
        </li>
        <li>Click a project header to open its popup; click a file to open it directly.</li>
        <li>
          Terminal logs aren't in the default results — pick the <strong>Logs</strong> filter to
          search transcripts.
        </li>
        <li>
          Hits are ranked: title &gt; meta &gt; headings &gt; body, with a bonus when terms appear
          close together.
        </li>
      </ul>
    </div>
  );
}
