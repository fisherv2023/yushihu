// api/ai.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ success: false, error: "缺少prompt" });
    }

    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "你是一位经验丰富的沈阳中考志愿填报专家，回答要简洁、准确、严格按照提供的数据。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.6,
        max_tokens: 800
      })
    });

    const data = await response.json();

    res.status(200).json({
      success: true,
      content: data.choices[0].message.content
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "服务器错误" });
  }
}
