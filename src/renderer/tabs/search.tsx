import { For } from 'solid-js';
import type { SearchHit } from '@shared/types';

export function SearchResult(props: { hit: SearchHit; onOpen: (path: string) => void }) {
  return (
    <li class="search-result">
      <button class="search-row" onClick={() => props.onOpen(props.hit.path)}>
        <div class="search-head">
          <span class="search-title">{props.hit.title}</span>
          <span class="badge">{props.hit.source}</span>
          <span class="search-count">{props.hit.matchCount}</span>
        </div>
        <span class="search-path">{props.hit.path}</span>
        <ul class="search-snippets">
          <For each={props.hit.snippets}>{(s) => <li>{s}</li>}</For>
        </ul>
      </button>
    </li>
  );
}
