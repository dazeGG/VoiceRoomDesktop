use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read, Write};

pub const MAX_FRAME: usize = 64 * 1024;
pub const VERSION: Version = Version { major: 1, minor: 0 };

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
pub struct Version {
    pub major: u16,
    pub minor: u16,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub v: Version,
    pub epoch: String,
    pub id: u32,
    pub kind: String,
    pub payload: Value,
}

pub fn read(input: &mut impl Read) -> Result<Option<Frame>, &'static str> {
    let mut len = [0; 4];
    match input.read(&mut len[..1]) {
        Ok(0) => return Ok(None),
        Ok(_) => {}
        Err(_) => return Err("bad-frame"),
    }
    input.read_exact(&mut len[1..]).map_err(|_| "bad-frame")?;
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err("frame-size");
    }
    let mut bytes = vec![0; len];
    input.read_exact(&mut bytes).map_err(|_| "bad-frame")?;
    let frame = serde_json::from_slice(&bytes).map_err(|_| "bad-frame")?;
    Ok(Some(frame))
}

pub fn write(output: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let bytes = serde_json::to_vec(frame)?;
    if bytes.len() > MAX_FRAME {
        return Err(io::ErrorKind::InvalidData.into());
    }
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_multiple_frames() {
        let frame = Frame {
            v: VERSION,
            epoch: "epoch".into(),
            id: 7,
            kind: "ping".into(),
            payload: json!({"label":"音"}),
        };
        let mut bytes = Vec::new();
        write(&mut bytes, &frame).unwrap();
        write(&mut bytes, &frame).unwrap();
        let mut input = bytes.as_slice();
        for _ in 0..2 {
            let parsed = read(&mut input).unwrap().unwrap();
            assert_eq!(parsed.id, 7);
            assert_eq!(parsed.payload, frame.payload);
        }
        assert!(read(&mut input).unwrap().is_none());
    }

    #[test]
    fn rejects_bad_lengths_truncated_frames_and_invalid_utf8() {
        for (input, error) in [
            (&[0, 0, 0, 0][..], "frame-size"),
            (&[1, 0, 1, 0], "frame-size"),
            (&[1, 0], "bad-frame"),
            (&[2, 0, 0, 0, b'{'], "bad-frame"),
            (&[1, 0, 0, 0, 0xff], "bad-frame"),
        ] {
            assert_eq!(read(&mut &input[..]).err(), Some(error));
        }
    }
}
