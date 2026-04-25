//! `GET /events` — server-sent events stream. Opens with a `hello`
//! frame so the browser's `EventSource.onopen` fires immediately, fans
//! out the event-bus payloads as `data:` frames, and punctuates the
//! stream with a 30-second keep-alive so reverse proxies don't kill
//! an idle connection.

use axum::extract::State;

use super::AppState;

pub(super) async fn events_stream(
    State(state): State<AppState>,
) -> axum::response::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event as SseEvent, KeepAlive};
    use futures_util::StreamExt;
    use tokio_stream::wrappers::BroadcastStream;

    let rx = state.event_bus.subscribe();
    let hello = futures_util::stream::once(async {
        Ok::<_, std::convert::Infallible>(SseEvent::default().event("hello").data("{}"))
    });
    let payloads = BroadcastStream::new(rx).filter_map(|res| async move {
        match res {
            Ok(payload) => {
                let data = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
                // Emit a named SSE event:
                //   - `<tab>` for pane-wide / structural events (the
                //     pane container's `hx-trigger="sse:<tab>"` fires)
                //   - `<tab>-<id>` for per-item events (a specific
                //     card's `hx-trigger="sse:<tab>-<id>"` fires;
                //     other cards stay quiet)
                // The generic `htmx:sseMessage` handler in `sse.js`
                // still fires for every frame regardless of name.
                Some(Ok::<_, std::convert::Infallible>(
                    SseEvent::default().event(payload.event_name()).data(data),
                ))
            }
            // Subscriber lagged behind the broadcast queue. The next
            // event will refresh; capacity is sized so this is rare
            // under normal use.
            Err(_) => None,
        }
    });
    let combined = hello.chain(payloads);
    axum::response::Sse::new(combined).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(30))
            .text("ping"),
    )
}
