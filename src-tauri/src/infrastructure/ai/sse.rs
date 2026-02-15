#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Minimal SSE decoder for streaming APIs (Anthropic, etc).
///
/// - Accepts arbitrary byte chunks (may split in the middle of an event)
/// - Splits events by a blank line (`\n\n` or `\r\n\r\n`)
/// - Extracts `event:` and `data:` lines
#[derive(Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();

        while let Some((pos, delim_len)) = find_event_delimiter(&self.buffer) {
            let block = self.buffer[..pos].to_vec();
            self.buffer.drain(..pos + delim_len);

            if let Some(event) = parse_sse_block(&block) {
                out.push(event);
            }
        }

        out
    }
}

fn find_event_delimiter(buf: &[u8]) -> Option<(usize, usize)> {
    let crlf = find_subslice(buf, b"\r\n\r\n").map(|pos| (pos, 4));
    let lf = find_subslice(buf, b"\n\n").map(|pos| (pos, 2));

    match (crlf, lf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }

    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parse_sse_block(bytes: &[u8]) -> Option<SseEvent> {
    let text = String::from_utf8_lossy(bytes);
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();

    for raw_line in text.split('\n') {
        let line = raw_line.trim_end_matches('\r');

        if line.is_empty() {
            continue;
        }

        // Comment/keep-alive line
        if line.starts_with(':') {
            continue;
        }

        if let Some(rest) = line.strip_prefix("event:") {
            let value = rest.trim();
            if !value.is_empty() {
                event_name = Some(value.to_string());
            }
            continue;
        }

        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start().to_string());
            continue;
        }
    }

    // If block has no meaningful content, ignore.
    if event_name.is_none() && data_lines.is_empty() {
        return None;
    }

    Some(SseEvent {
        event: event_name,
        data: data_lines.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_event_lf() {
        let mut dec = SseDecoder::new();
        let events = dec.push(
            b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n",
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.as_deref(), Some("content_block_delta"));
        assert_eq!(events[0].data, "{\"type\":\"content_block_delta\"}");
    }

    #[test]
    fn parses_single_event_crlf() {
        let mut dec = SseDecoder::new();
        let events = dec.push(
            b"event: message_stop\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n",
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.as_deref(), Some("message_stop"));
        assert_eq!(events[0].data, "{\"type\":\"message_stop\"}");
    }

    #[test]
    fn parses_multiple_events_in_one_chunk() {
        let mut dec = SseDecoder::new();
        let events = dec.push(
            b"event: a\ndata: 1\n\nevent: b\ndata: 2\n\n",
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event.as_deref(), Some("a"));
        assert_eq!(events[0].data, "1");
        assert_eq!(events[1].event.as_deref(), Some("b"));
        assert_eq!(events[1].data, "2");
    }

    #[test]
    fn parses_event_split_across_chunks() {
        let mut dec = SseDecoder::new();
        let a = dec.push(b"event: a\ndata: hello");
        assert!(a.is_empty());
        let b = dec.push(b"\n\n");
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].event.as_deref(), Some("a"));
        assert_eq!(b[0].data, "hello");
    }
}

