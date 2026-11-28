use base64::{engine::general_purpose::STANDARD, Engine};

pub struct ChatImage<'a> {
    pub mime: &'a str,
    pub extension: &'static str,
    pub encoded: &'a str,
    pub bytes: Vec<u8>,
}

pub fn parse(urls: &[String]) -> Result<Vec<ChatImage<'_>>, String> {
    let invalid = "Les pièces jointes doivent être des images PNG, JPEG ou WebP.";
    let mut total = 0;
    if urls.len() > 4 { return Err("Quatre images maximum par message.".into()); }
    urls.iter().map(|url| {
        let (mime, encoded) = url.strip_prefix("data:").and_then(|s| s.split_once(";base64,")).ok_or(invalid)?;
        let extension = match mime {
            "image/png" => "png", "image/jpeg" => "jpg", "image/webp" => "webp", _ => return Err(invalid.into())
        };
        if encoded.len() > 7 << 20 { return Err(invalid.into()); }
        let bytes = STANDARD.decode(encoded).map_err(|_| invalid)?;
        total += bytes.len();
        if bytes.is_empty() || total > 5 << 20 { return Err("Images vides ou trop volumineuses (5 Mio maximum).".into()); }
        Ok(ChatImage { mime, extension, encoded, bytes })
    }).collect()
}
