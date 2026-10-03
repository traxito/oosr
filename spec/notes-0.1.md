# Notas de implementación sobre el Draft 0.1

La implementación de referencia (`packages/`) tuvo que decidir puntos que el Draft 0.1 deja
abiertos o que chocan con estándares existentes. Cada punto es una propuesta para el Draft 0.2 y
tiene (o tendrá) su issue para discutirlo. Los JSON Schemas de [`schemas/v0`](../schemas/v0)
reflejan estas decisiones.

## Formato y firma

1. **`oosrsig` es un string, no un objeto.** CloudEvents 1.0 solo admite atributos de extensión
   escalares; un objeto rompe la promesa de "cualquier broker o SDK lo transporta sin cambios".
   `oosrsig` es un JWS compacto *detached* (RFC 7515, apéndice F): `<cabecera>..<firma>`, con
   cabecera `{"alg":"ES256","kid":"..."}`, sobre la forma JCS (RFC 8785) del evento sin `oosrsig`.
2. **El mismo formato firma los manifiestos.** `signature.value` es un JWS detached sobre el
   `manifest.json` canónico sin el miembro `signature`; `alg` y `kid` deben coincidir con la cabecera.
3. **Hashes de ficheros dentro del manifiesto.** Nuevo campo `integrity`: mapa
   `ruta → "sha256-<base64>"` de cada fichero del paquete (estilo SRI). Lo cubre la firma. Un paquete
   con ficheros no listados, o al que le falta alguno listado, es inválido.
4. **El id de una skill está ligado al publisher.** `skill:<id-did-web con ':' → '/'>/<nombre>`:
   `did:web:vivero-x.es` solo puede firmar `skill:vivero-x.es/*`, y `did:web:traxito.github.io:oosr`
   solo `skill:traxito.github.io/oosr/*`. Sin esta regla un publisher de confianza podría suplantar
   skills de otro.
5. **Registro de skills de un publisher.** El documento DID anuncia un servicio de tipo
   `OOSRSkillRegistry`. Contenido: `<endpoint>/index.json` y `<endpoint>/<nombre>/<versión>.json`
   (paquete: manifiesto + ficheros en base64). Es lo que el hub usa al precargar skills desde el QR
   GS1 durante el enrolment.
6. **Claves de publisher fijadas (pinned) en el hub.** Para ser local-first el hub puede guardar la
   clave pública de un `kid`; solo resuelve `did:web` cuando no la tiene.

## Matching y ejecución

7. **Primitivas con calificador.** Un requisito `p` lo satisface `p` o cualquier `p:q`; un requisito
   `p:q` solo lo satisface `p:q` (el calificador nombra hardware concreto: sonda de humedad,
   depósito de agua). Calificadores v0: `measure:<sensor>`, `dispense:<liquid>`.
8. **Los `steps` deben estar declarados en `requires`** (validación del publisher) y todo `dispense`
   debe estar acotado (`volume_ml` numérico o `constraints.max_volume_ml`), para que el matching
   contra `limits` sea decidible sin conocer el objeto.
9. **Atributos estándar** que las skills pueden usar: `pot_volume_l`, `mass_kg`.
10. **Condiciones de tres valores.** Una medida desconocida da "desconocido", no falso. `since_event`
    sin evento previo cuenta como infinitamente antiguo. El robot mide (sin reservar nada, con
    `oosr.observation.recorded`) antes de pedir un lease, así se evitan reservas inútiles.
11. **`season` se escribe para el hemisferio norte**; la política añade `hemisphere` y `timezone`
    (IANA), que también usa `quiet_hours`.
12. **Versiones.** El hub elige la mayor versión instalada de la misma major que cumpla
    `min_version`. Una major nueva nunca se adopta sola (coherente con "major obliga a
    re-aprobación").

## Estado, eventos y concurrencia

13. **Nuevos tipos de evento emitidos por el hub:** `oosr.object.updated` (cambios de nombre, zona,
    atributos o skills desde la app), `oosr.approval.denied` y `oosr.alert.acknowledged`.
14. **`notify_human` se materializa como observación:** `oosr.observation.recorded` con
    `data.notify = {severity, message_key}` y `oosrskill` obligatorio; el hub rechaza claves que no
    estén en `messages` de esa skill.
15. **Convención de medidas.** En `task.*.completed`: `<sensor>_before` / `<sensor>_after`. En
    observaciones: `data.measurements = {<sensor>: valor}`.
16. **Leases.** Clave `(objeto, tarea)`, como dice el RFC. El mismo robot puede renovar su lease. Un
    `completed`/`failed` de una tarea física exige una ejecución abierta por ese mismo robot (aunque
    el lease haya expirado, si nadie lo ha tomado después). La expiración usa el reloj del hub en la
    recepción, no el del robot. **Abierto:** ¿debería el lease ser por objeto para tareas físicas?
    (Regar y trasladar la maceta a la vez también es un conflicto.)
17. **Offline.** Un robot sin conexión no puede iniciar tareas físicas, porque no puede obtener lease.
    Las observaciones sí se encolan y sincronizan.
18. **Higiene del log.** El hub rechaza eventos con `time` más de 5 minutos en el futuro. Reenviar un
    evento idéntico es idempotente; reutilizar un `id` con otro contenido es un conflicto (409).

## Confianza y autorización

19. **Aprobaciones.** Flujo solicitud → decisión. El robot pide la aprobación, el humano la concede
    en la app y el hub emite `oosr.approval.granted`, firmado con la clave del hub en nombre del
    propietario (los humanos no tienen claves en v0). La aprobación es de un solo uso y cubre
    `(objeto, tarea, skill, robot)`; el robot la referencia con `data.approval_id` en el `started`.
20. **`always_require_approval`** acepta primitivas (`cut`) o capacidades calificadas (`dispense:water`).
21. **El hub vuelve a comprobar todo en cada `started`:** publisher todavía de confianza, skill
    aplicable al objeto, robot elegible (matching), zona, temporada, horas de silencio, aprobación y
    lease. El matching del robot es una optimización, no la defensa.
22. **Pendiente:** verificar el certificado de dispositivo del fabricante (falta definir el formato
    de la cadena). La implementación lo acepta y lo guarda, y la app avisa si no se aportó.
23. **Pendiente:** passkeys para el propietario. La referencia v0 usa un token bearer de propietario.
