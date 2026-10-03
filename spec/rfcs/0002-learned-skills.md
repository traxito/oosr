# RFC-0002: Skills aprendidas por robots

| | |
|---|---|
| **Fecha** | 3 oct 2026 |
| **Autor** | Alex Montesinos |
| **Estado** | Borrador (abierto a comentarios 14 días) |
| **Depende de** | RFC-0001 |

## 1. Motivación

El RFC-0001 deja abierta esta pregunta: ¿puede un robot publicar skills aprendidas por experiencia?
La respuesta es **sí**, con límites. Un robot que riega el mismo ficus durante meses aprende cosas
que el vivero no puede saber: que esa maceta junto al radiador se seca en 4 días y no en 7, o que
con 60 ml/l basta. Si ese conocimiento se queda dentro del robot, se pierde al cambiar de robot y
los demás robots de la casa no lo aprovechan.

El riesgo es obvio: un robot comprometido o mal calibrado que "aprende" a regar cada hora. Este RFC
define cómo aprovechar lo aprendido sin que nada aprendido pueda elevar permisos.

## 2. Principios

1. **Lo aprendido nunca amplía lo permitido.** Una skill aprendida solo puede moverse dentro de
   los límites que ya autorizó un publisher de confianza y la política del hogar.
2. **Local por defecto.** Lo aprendido vive en el hub del hogar. Salir de casa requiere un acto
   explícito del propietario y la firma de un publisher.
3. **Con evidencia.** Cada ajuste referencia los eventos firmados que lo justifican.
4. **Reversible.** El propietario ve, desactiva y borra cualquier cosa aprendida desde la app.

## 3. Dos niveles

### Nivel 1: overlay de parámetros

Ajusta parámetros de una tarea de una skill firmada, **dentro de rangos que el publisher declara
como ajustables**. El manifiesto base añade `tunable`:

```json
{
  "name": "water",
  "trigger": { "any": [{ "since_event": "oosr.task.water.completed", "gt_days": 7 }, { "measure": "soil_moisture", "lt": 0.20 }] },
  "tunable": {
    "/trigger/any/0/gt_days": { "min": 3, "max": 14 },
    "/trigger/any/1/lt": { "min": 0.12, "max": 0.28 },
    "/steps/2/volume_ml/per_pot_litre": { "min": 50, "max": 100 }
  }
}
```

Las claves son JSON Pointers relativos a la tarea. Lo que no está en `tunable` no se puede tocar.
`constraints` nunca es ajustable.

El overlay lo firma el robot:

```json
{
  "oosr": "0.2",
  "kind": "overlay",
  "id": "overlay:hub-7f3a/0192f7aa-...",
  "base": "skill:vivero-x.es/ficus-lyrata-care@1.2.0",
  "subject": "urn:oosr:obj:hub-7f3a:0192f5e1-...",
  "task": "water",
  "set": { "/trigger/any/0/gt_days": 4, "/steps/2/volume_ml/per_pot_litre": 65 },
  "provenance": {
    "learned_by": "urn:oosr:robot:acme:sn-88412",
    "method": "moisture-decay-fit/v1",
    "evidence": ["0192f6a0-...", "0192f8c1-...", "0192fa02-..."]
  },
  "signature": { "alg": "ES256", "kid": "urn:oosr:robot:acme:sn-88412#att", "value": "..." }
}
```

El hub lo acepta si: la base está instalada y es de confianza; todas las rutas están en `tunable`
y los valores dentro de rango; los eventos de `evidence` existen, tratan sobre ese objeto y los
firmó ese robot; y la política lo permite. Un overlay aplica a **un objeto** y nunca a un tipo.
Al subir la major de la base, los overlays caducan.

### Nivel 2: skill aprendida

Tareas nuevas compuestas solo con primitivas del vocabulario, para objetos sin skill o para
necesidades que la skill no cubre. Restricciones:

- `publisher` es el URN del robot y `provenance.kind = "learned"`.
- Ámbito: solo el hub donde se aprendió. Otro hub la rechaza aunque confíe en el fabricante del robot.
- **Toda tarea con efecto físico exige aprobación humana**, digan lo que digan el manifiesto o la
  política, hasta que el propietario la "gradúe" tras N ejecuciones supervisadas sin fallo (N lo fija
  la política; por defecto 5).
- `dispense` y `cut` necesitan `constraints` explícitas, y nunca por encima de las de cualquier
  skill de confianza instalada para ese tipo de objeto, si la hay.

**Promoción.** Para salir del hogar, una skill aprendida tiene que firmarla de nuevo un publisher
de confianza (fabricante, vivero o comunidad) tras revisarla. Así entra al ecosistema, con su
`provenance` intacto como atribución.

## 4. Niveles de confianza

| Origen | Firmado por | Ámbito | Efecto físico |
|---|---|---|---|
| Skill de publisher | `did:web` de confianza | cualquier hub que confíe | según política |
| Overlay (N1) | robot emparejado | un objeto, un hub | dentro de `tunable` y `constraints` de la base |
| Skill aprendida (N2) | robot emparejado | un hub | siempre con aprobación hasta graduarse |
| Aprendida y promovida | `did:web` de confianza | como una skill de publisher | según política |

## 5. Cambios propuestos

- Manifiesto: campo opcional `tunable` por tarea; `provenance` opcional.
- Nuevo documento `overlay` (schema `schemas/v0/overlay.json`, en un PR aparte).
- Política del hogar:

```json
{
  "learned": {
    "overlays": "allow",
    "skills": "approval",
    "graduate_after": 5,
    "share": false
  }
}
```

  `overlays`: `off | allow`. `skills`: `off | approval`. `share`: si se permite exportar lo
  aprendido para revisión (siempre con consentimiento explícito por elemento).
- Eventos: `oosr.learned.proposed` (robot), `oosr.learned.accepted` / `oosr.learned.revoked` (hub).
- API: `POST /v0/learned`, `GET /v0/objects/{urn}/learned`, `DELETE /v0/learned/{id}`.
- App: una sección "Lo que han aprendido los robots", con diff legible ("regar cada 4 días en lugar
  de 7, porque se seca antes: ver 3 riegos").

## 6. Amenazas

| Amenaza | Mitigación |
|---|---|
| Robot comprometido aprende "regar siempre" | Rangos `tunable`, `constraints` no ajustables, scopes de escritura, revocación |
| Deriva por sensor mal calibrado | Evidencia obligatoria; el hub puede pedir que la confirme un segundo robot o sensor; los overlays caducan |
| Fuga de datos del hogar al compartir | `share: false` por defecto; la promoción la hace un publisher con consentimiento por elemento |
| Skill aprendida como vector de phishing | Igual que en RFC-0001: solo `message_key`; las skills aprendidas no pueden definir mensajes nuevos, solo reutilizar los de skills de confianza |

## 7. Preguntas abiertas

- [ ] ¿Debe el hub recalcular o verificar el ajuste a partir de la evidencia (p. ej. con un método
      de ajuste estándar) o basta con comprobar que la evidencia existe?
- [ ] ¿Cómo se resuelven overlays contradictorios de dos robots para el mismo objeto? (Propuesta:
      gana el más reciente con más evidencia; la app muestra el conflicto.)
- [ ] ¿Merece la pena un formato de "evidencia agregada" anónima para que los publishers mejoren sus
      skills con datos de muchos hogares, y con qué garantías de privacidad?
