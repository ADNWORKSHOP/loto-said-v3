
export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json({
    ok: true,
    service: "Loto Votre Chance - FDJ",
    message: "Fonction serveur opérationnelle",
    automatique: false
  });
}
