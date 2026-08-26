# Revisión estadística — graft-retrieval-bench

Recálculo de dos cifras publicadas: el **5.5× de tokens por consulta** y el
**36.7% vs 7.8% de localidad de fallos**. Hecho el 2026-08-15 sobre los
resultados crudos del repo, sin re-ejecutar el benchmark.

**Fuente de datos:** `results/*-k10-b400.json` (django, nest, pocketbase,
spring-boot), condición `natural`, k=10, budget=400, n=186 consultas.
Cifras de localidad: `results/HYPOTHESES.json`.

**Estado:** las cifras publicadas son correctas. Lo que sigue son los
estadísticos que faltaban y tres advertencias metodológicas, una de ellas seria.

---

## 1. Tokens por consulta (n=186)

| | Graft | BM25 |
|---|---:|---:|
| Media | 810.63 | 146.67 |
| Mediana | 680.50 | 84.50 |
| Q1 | 421.75 | 68.25 |
| Q3 | 1006.25 | 262.50 |
| **IQR** | **584.50** | **194.25** |
| Rango | 53 – 3671 | 44 – 457 |
| Desv. est. | 578.31 | 109.26 |
| p90 / p95 / p99 | 1494 / 1812 / 3063 | 323 / 349 / 409 |

### De dónde sale el 5.5×

Es **razón de medias**. Verificado en código, no inferido:

- `bench/report.mjs:57` → `packTokens: mean(rows.map((x) => x.packTokens))`
- `bench/report.mjs:87` → `s.packTokens / base.packTokens`

810.63 / 146.67 = **5.527 → 5.5×**

Las otras definiciones dan más:

| Definición | Valor |
|---|---:|
| media / media | **5.53×** ← el publicado |
| mediana / mediana | 8.05× |
| media de las razones por consulta | 6.97× |
| mediana de las razones por consulta | 6.29× |

### Cola larga: sí, en ambos

| | Graft | BM25 |
|---|---:|---:|
| Asimetría (skew) | +2.00 | +1.06 |
| Media / mediana | 1.19 | 1.74 |
| Consultas por encima de la media | 69 / 186 | 51 / 186 |
| Tokens que concentra el decil más caro | 27% | 25% |

**Dos consecuencias:**

1. **El 5.5× subestima, no exagera.** Es la menor de las tres definiciones. En
   la consulta mediana la brecha es 8.05×. El argumento juega a favor del post.
2. **Las colas no son comparables.** BM25 topa en 457 tokens porque el budget es
   400 — su distribución está truncada. Graft no lo está y llega a 3671. Parte
   del cociente sale de que a un sistema lo corta el presupuesto y al otro no.

---

## 2. Localidad de fallos: 79 de 215

### Corrección al supuesto de partida

**Nunca hubo un IC para el 36.7%.** `results/HYPOTHESES.json` guarda
`oneHopRate`, `oneHopChance` y `oneHopLift`, pero ningún intervalo. Los de abajo
se calcularon en esta revisión. (El repo sí usa Wilson en otro lado: `wilson95`
para el `hitRate` en `report.mjs:56`.)

### Intervalos de confianza al 95% para 79/215 = 36.74%

| Método | IC 95% |
|---|---|
| Clopper-Pearson (exacto) | **[30.29%, 43.57%]** |
| Wilson | [30.59%, 43.37%] |
| Wald / normal | [30.30%, 43.19%] |

### Significancia contra el 7.826% de azar

| Prueba | Estadístico | p |
|---|---|---|
| Binomial exacta, una cola | P(X≥79 \| p=0.07826) | 9.9 × 10⁻³³ |
| Binomial exacta, dos colas | — | 9.9 × 10⁻³³ |
| Chi-cuadrado bondad de ajuste, gl=1 | X² = 249.3 | 3.8 × 10⁻⁵⁶ |

Esperados por azar: 16.83 de 215. Observados: 79.

### Advertencia 1 — los 215 fallos no son independientes

Vienen de 186 consultas (varias aportan más de un archivo gold) agrupadas en 4
repos. La binomial asume 215 ensayos independientes, así que **el IC de arriba
es más angosto de lo que corresponde**.

Reparable: los `wiring.json` de los 4 repos siguen en `repos/`, así que
`bench/verify-hypotheses.mjs` se puede reejecutar para obtener las filas por
consulta y construir un IC robusto por clúster (bootstrap por consulta, o por
repo). **Pendiente, no hecho.**

### Advertencia 2 — numerador y denominador ponderan distinto

El 36.7% pondera por **fallos**. El 7.826% es el promedio de la cobertura 1-hop
por **consulta** — verificado: es exactamente la media de `cov1` ponderada por
n de cada repo.

Reponderando el azar por fallos:

| Ponderación del azar | Azar | Lift |
|---|---:|---:|
| Por consultas (publicado) | 7.83% | 4.70× |
| Por fallos | 9.26% | **3.97×** |

Con el azar reponderado: X² = 193.2, gl=1, p = 6.2 × 10⁻⁴⁴. Sigue siendo
abrumador, pero el "4.7×" depende de esa mezcla.

### Advertencia 3 — la heterogeneidad entre repos (la seria)

| Repo | Consultas | Fallos | 1-hop | Observado | Azar | Lift |
|---|---:|---:|---:|---:|---:|---:|
| pocketbase | 50 | 76 | 40 | 52.6% | 20.37% | 2.6× |
| nest | 37 | 49 | 2 | 4.1% | 2.42% | 1.7× |
| django | 50 | 47 | 22 | 46.8% | 6.19% | 7.6× |
| spring-boot | 49 | 43 | 15 | 34.9% | 0.77% | **45.0×** |
| **pooled** | **186** | **215** | **79** | **36.7%** | **7.83%** | **4.7×** |

En nest el efecto casi no existe (2 de 49 fallos). En spring-boot el lift es 45×.
El agregado descansa sobre todo en **pocketbase, que aporta 40 de las 79
capturas** — y es justo el repo con la vecindad 1-hop más ancha (20% del repo).

La dirección es consistente: los cuatro superan su propio azar. Pero
**"36.7% contra 7.8%" no describe a ningún repo en particular.** Si el post lo
presenta como un hallazgo único y estable, esta tabla es la corrección a
publicar.

---

## Cómo reproducirlo

Los estadísticos se calcularon con Python 3 puro (sin scipy, que no está
instalado en esta máquina): cuantiles tipo 7 (igual que numpy/R por defecto),
Clopper-Pearson por bisección sobre la beta incompleta regularizada (continued
fraction de Lentz), binomial exacta en espacio logarítmico, y chi-cuadrado con
gl=1 vía `erfc(sqrt(X²/2))`.

Tokens, desde la raíz de `graft-bench`:

```bash
python3 -c "
import json,glob,statistics as st
g=[];b=[]
for f in sorted(glob.glob('results/*-k10-b400.json')):
    for r in json.load(open(f))['results']:
        c=r['byCondition']['natural']
        g.append(c['graft']['packTokens']); b.append(c['bm25']['packTokens'])
print(len(g), st.mean(g), st.median(g), st.mean(b), st.median(b))
"
```

Pendiente para cerrar la advertencia 1:

```bash
node bench/verify-hypotheses.mjs
```

---

## Resumen para quien retome esto

- El **5.5×** es razón de medias, está bien calculado, y es la lectura más
  conservadora de tres posibles. Vale la pena decir en el post cuál es.
- El **36.7%** tiene ahora IC 95% exacto **[30.3%, 43.6%]** y p < 10⁻³² contra
  azar. La significancia no está en duda.
- Lo que sí conviene matizar es el **4.7× de lift**: baja a 3.97× con el azar
  reponderado por fallos, y varía entre 1.7× y 45× según el repo.
- Falta un IC robusto por clúster. Es lo único que requiere reejecutar código.
