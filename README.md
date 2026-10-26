# Mes dépenses

PWA perso de suivi de dépenses (iPhone d'abord), en français.

- **Hébergement** : GitHub Pages (fichiers statiques, aucune compilation).
- **Données et connexion** : Firebase projet `mes-depenses-26384` (Firestore europe-west9, connexion par lien magique e-mail). Les règles Firestore n'autorisent que `users/{uid}/…` pour le propriétaire (e-mail vérifié).
- **Hors ligne** : service worker (`sw.js`) pour la coquille + cache Firestore persistant (les saisies hors ligne partent à la reconnexion).

## Fichiers
- `index.html`, `style.css` : interface.
- `app.js` : écrans (saisie, mois, tableau, historique, budget, réglages), import/export CSV.
- `lib.js` : fonctions pures (montants, dates, CSV, catégories par défaut).
- `store.js` : accès Firestore (ou stockage local en mode démo).
- `tools/make_icons.py` : génère les icônes.

## Développement
```bash
python -m http.server 8765
```
Puis ouvrir `http://localhost:8765/?demo` (données factices en local, sans compte).

## Mise en ligne
```bash
./deploy.sh "message"
```
