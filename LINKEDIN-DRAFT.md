# Borrador LinkedIn — versión final (seis correcciones de credibilidad aplicadas)

Hace unos días me topé con muchas publicaciones de un repo con números espectaculares: 46% menos llamadas, 32% menos coste, 66% en SWE-bench contra 54%.

Es Graft, de Nanonets. En vez de solo compartirlo, lo medí.

━━━━━━━━━━━━━━━━━━━━

LO QUE ES VERDAD

→ El código es bueno. 622 tests pasan, TypeScript estricto.
→ Construye el grafo en 1.8s sobre 153 archivos. Gratis, sin API key.
→ Cero telemetría: no hay ni una llamada de red en su código fuente. MIT, sin cuenta.
→ Su comando skeleton reduce tokens un 76-91% frente a leer el archivo entero. Lo medí sobre 325 archivos. Ese ahorro es real.

━━━━━━━━━━━━━━━━━━━━

LO QUE NO SE SOSTUVO

→ No hay ningún benchmark en el repositorio. Ni script, ni datos, ni logs: el 46% y el 32% no son verificables por nadie, ni a favor ni en contra.
→ Su web dice "Reproduce with npm run bench". Ese script no existe.
→ El "66% vs 54%" mezcla dos experimentos. Su propio README dice que la corrección fue IGUAL: 93% vs 93%.
→ Su web dice "+5 puntos (provisional)". Su README dice "+12 puntos".

Así que construí el benchmark que faltaba.

━━━━━━━━━━━━━━━━━━━━

LO QUE ENCONTRÉ AL MEDIRLO

186 pull requests ya mergeados de 4 repos reales. El issue como pregunta, los archivos que el mantenedor tocó como respuesta, y el grafo construido siempre en el commit anterior al arreglo. Sin modelo juez, sin API key, $0.

→ Su búsqueda queda 18 puntos por debajo de un BM25 sin grafo: 48.5% contra 66.5%, IC 95% [-24.4, -11.5].
→ Y cobra 5.5x más tokens por consulta.
→ Pero señalar errores no sirve. Busqué el porqué: el 36,7% de los archivos que falla están a una arista de uno que sí devolvió, contra un azar del 7,8%.

Su extractor construye bien las conexiones. Su ranker no las recorre. No prueba que expandir el grafo lo arregle: prueba que la información ya está ahí. Ya está abierto como issue en su repo.

Sobre el alcance: esto mide recuperación de archivos, no el coste real de una sesión de agente. Sus cifras de eficiencia siguen sin ser reproducibles, y ese es justamente el punto.

━━━━━━━━━━━━━━━━━━━━

Lo que más aprendí fue equivocarme. Mi titular iba a ser "el 64% de los fallos están a dos saltos", hasta que calculé que ese vecindario cubre el 69% del repositorio: peor que el azar. Publicarlo sin validar habría sido difundir con tono de autoridad exactamente lo que estaba criticando.

Validar antes de compartir cuesta unas horas. Es lo que separa una comunidad técnica de un canal de novedades.

Todo reproducible, incluidos los tres bugs que encontré en mi propio instrumento de medición.

#Ingeniería #OpenSource #IA #DesarrolloDeSoftware
