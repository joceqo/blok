import {shellText} from './shell-i18n';
import './cover-controls.css';
import { registerLayer } from '../../src/components/utils/dismissable-layer';
import { createCoverDownloadButton } from '../../src/components/utils/cover-download';
import additionalCover0 from './assets/covers/cma_130391.jpg';
import additionalCover1 from './assets/covers/cma_136207.jpg';
import additionalCover2 from './assets/covers/cma_115067.jpg';
import additionalCover3 from './assets/covers/cma_143462.jpg';
import additionalCover4 from './assets/covers/cma_153736.jpg';
import additionalCover5 from './assets/covers/cma_135469.jpg';
import additionalCover6 from './assets/covers/cma_153737.jpg';
import additionalCover7 from './assets/covers/cma_153735.jpg';
import additionalCover8 from './assets/covers/cma_125886.jpg';
import additionalCover9 from './assets/covers/cma_125884.jpg';
import additionalCover10 from './assets/covers/cma_92480.jpg';
import additionalCover11 from './assets/covers/cma_143272.jpg';
import additionalCover12 from './assets/covers/cma_101951.jpg';
import additionalCover13 from './assets/covers/cma_83453.jpg';
import additionalCover14 from './assets/covers/cma_130974.jpg';
import additionalCover15 from './assets/covers/cma_134862.jpg';
import additionalCover16 from './assets/covers/cma_157428.jpg';
import additionalCover17 from './assets/covers/cma_97315.jpg';
import additionalCover18 from './assets/covers/cma_142659.jpg';
import additionalCover19 from './assets/covers/cma_119697.jpg';
import additionalCover20 from './assets/covers/cma_113945.jpg';
import additionalCover21 from './assets/covers/cma_130361.jpg';
import additionalCover22 from './assets/covers/cma_149791.jpg';
import additionalCover23 from './assets/covers/cma_145010.jpg';
import additionalCover24 from './assets/covers/cma_160138.jpg';
import additionalCover25 from './assets/covers/cma_143477.jpg';
import additionalCover26 from './assets/covers/cma_135836.jpg';
import additionalCover27 from './assets/covers/cma_160137.jpg';
import additionalCover28 from './assets/covers/cma_136296.jpg';
import additionalCover29 from './assets/covers/cma_144732.jpg';
import additionalCover30 from './assets/covers/cma_159739.jpg';
import additionalCover31 from './assets/covers/cma_150165.jpg';
import additionalCover32 from './assets/covers/cma_148810.jpg';
import expansionCover0 from './assets/covers/polyhaven_dark_wood.jpg';
import expansionCover1 from './assets/covers/polyhaven_plywood.jpg';
import expansionCover2 from './assets/covers/polyhaven_rosewood_veneer1.jpg';
import expansionCover3 from './assets/covers/polyhaven_wood_table.jpg';
import expansionCover4 from './assets/covers/polyhaven_brown_leather.jpg';
import expansionCover5 from './assets/covers/polyhaven_fabric_pattern_05.jpg';
import expansionCover6 from './assets/covers/polyhaven_fabric_pattern_07.jpg';
import expansionCover7 from './assets/covers/polyhaven_quatrefoil_jacquard_fabric.jpg';
import expansionCover8 from './assets/covers/polyhaven_aerial_sand.jpg';
import expansionCover9 from './assets/covers/polyhaven_coast_sand_01.jpg';
import expansionCover10 from './assets/covers/polyhaven_damp_beach_sand.jpg';
import expansionCover11 from './assets/covers/polyhaven_dense_sand.jpg';
import expansionCover12 from './assets/covers/polyhaven_dark_rock.jpg';
import expansionCover13 from './assets/covers/polyhaven_coral_gravel.jpg';
import expansionCover14 from './assets/covers/polyhaven_cobblestone_color.jpg';
import expansionCover15 from './assets/covers/polyhaven_moss_wood.jpg';
import expansionCover16 from './assets/covers/polyhaven_white_plaster_02.jpg';
import expansionCover17 from './assets/covers/polyhaven_blue_plaster_weathered.jpg';
import expansionCover18 from './assets/covers/polyhaven_painted_plaster_wall.jpg';
import expansionCover19 from './assets/covers/polyhaven_rusty_metal.jpg';
import expansionCover20 from './assets/covers/polyhaven_metal_plate.jpg';
import expansionCover21 from './assets/covers/polyhaven_rough_concrete.jpg';
import expansionCover22 from './assets/covers/polyhaven_plastered_wall.jpg';
import expansionCover23 from './assets/covers/polyhaven_red_brick_plaster_patch_02.jpg';
import expansionCover24 from './assets/covers/cma_152006.jpg';
import expansionCover25 from './assets/covers/cma_151298.jpg';
import expansionCover26 from './assets/covers/cma_171296.jpg';
import expansionCover27 from './assets/covers/cma_139454.jpg';
import expansionCover28 from './assets/covers/cma_148739.jpg';
import expansionCover29 from './assets/covers/cma_79932.jpg';
import expansionCover30 from './assets/covers/cma_125873.jpg';
import expansionCover31 from './assets/covers/cma_143234.jpg';
import expansionCover32 from './assets/covers/cma_143602.jpg';
import expansionCover33 from './assets/covers/cma_83635.jpg';
import expansionCover34 from './assets/covers/cma_159501.jpg';
import expansionCover35 from './assets/covers/cma_149417.jpg';
import expansionCover36 from './assets/covers/cma_112586.jpg';
import expansionCover37 from './assets/covers/cma_141639.jpg';
import expansionCover38 from './assets/covers/cma_159769.jpg';
import expansionCover39 from './assets/covers/cma_150176.jpg';
import extraCover0 from './assets/covers/polyhaven_blue_plaster_wall.jpg';
import extraCover1 from './assets/covers/polyhaven_blue_metal_plate.jpg';
import extraCover2 from './assets/covers/polyhaven_green_metal_rust.jpg';
import extraCover3 from './assets/covers/polyhaven_grey_plaster.jpg';
import extraCover4 from './assets/covers/polyhaven_denim_fabric.jpg';
import extraCover5 from './assets/covers/polyhaven_marble_01.jpg';
import extraCover6 from './assets/covers/polyhaven_clay_plaster.jpg';
import extraCover7 from './assets/covers/polyhaven_rusty_painted_metal.jpg';
import extraCover8 from './assets/covers/polyhaven_concrete.jpg';
import extraCover9 from './assets/covers/polyhaven_red_plaster_weathered.jpg';
import extraCover10 from './assets/covers/polyhaven_yellow_plaster.jpg';
import extraCover11 from './assets/covers/met_436965.jpg';
import extraCover12 from './assets/covers/met_436105.jpg';
import extraCover13 from './assets/covers/met_436121.jpg';
import extraCover14 from './assets/covers/met_437853.jpg';
import extraCover15 from './assets/covers/met_437980.jpg';
import extraCover16 from './assets/covers/met_436524.jpg';
import extraCover17 from './assets/covers/met_437881.jpg';
import extraCover18 from './assets/covers/met_436529.jpg';
import extraCover19 from './assets/covers/met_436532.jpg';
import earth from './assets/covers/nasa_the_blue_marble.jpg';
import desert from './assets/covers/nasa_great_sandy_desert_australia.jpg';
import nebula from './assets/covers/webb1.jpg';
import oxbow from './assets/covers/met_oxbow.jpg';
import lakeGeorge from './assets/covers/met_lake_george.jpg';
import rockyMountains from './assets/covers/met_rocky_mountains.jpg';
import aegeanSea from './assets/covers/met_aegean_sea.jpg';
import greatWave from './assets/covers/met_great_wave.jpg';
import seteWave from './assets/covers/met_sete_wave.jpg';
import cypresses from './assets/covers/met_wheat_field_cypresses.jpg';
import summerAfternoon from './assets/covers/met_summer_afternoon.jpg';
import gulfStream from './assets/covers/met_gulf_stream.jpg';
import irises from './assets/covers/met_irises.jpg';
import roses from './assets/covers/met_roses.jpg';
import haraFuji from './assets/covers/met_hara_fuji.jpg';
import nihonbashi from './assets/covers/met_nihonbashi.jpg';
import fujiSenju from './assets/covers/met_fuji_senju.jpg';

export const COVER_GROUPS = [
  { label: shellText("Couleurs et dégradés"), items: [
    { id: 'dusk', label: shellText("Crépuscule"), background: 'linear-gradient(115deg, #24304b, #82587b 54%, #d49470)' },
    { id: 'ocean', label: shellText("Océan"), background: 'linear-gradient(110deg, #102d43, #266e82 50%, #83afa5)' },
    { id: 'forest', label: shellText("Forêt"), background: 'linear-gradient(115deg, #193a34, #4f745e 55%, #a5a979)' },
    { id: 'clay', label: shellText("Terre"), background: 'linear-gradient(110deg, #4e3530, #aa695a 53%, #e2b78c)' },
    { id: 'violet', label: shellText("Violet"), background: 'linear-gradient(115deg, #322450, #654a9a 55%, #b78bb4)' },
    { id: 'sunrise', label: shellText("Aurore"), background: 'linear-gradient(110deg, #fad0c4, #ffd1ff)' },
    { id: 'sky', label: shellText("Ciel"), background: 'linear-gradient(110deg, #a1c4fd, #c2e9fb)' },
    { id: 'mint', label: shellText("Menthe"), background: 'linear-gradient(110deg, #84fab0, #8fd3f4)' },
    { id: 'sand', label: shellText("Sable"), background: 'linear-gradient(110deg, #e6d9bd, #f5eee0)' },
    { id: 'rose', label: shellText("Rose"), background: 'linear-gradient(110deg, #e8b5bd, #f8dedb)' },
    { id: 'midnight', label: shellText("Minuit"), background: 'linear-gradient(110deg, #141e30, #475978)' },
    { id: 'paper', label: shellText("Papier"), background: 'linear-gradient(110deg, #6a695f, #a8a494 52%, #ded9c7)' },
  ] },
  { label: shellText("Couleurs unies"), items: [
    { id: 'solid-cream', label: shellText("Crème"), background: 'linear-gradient(#e8dfcf, #e8dfcf)' },
    { id: 'solid-stone', label: shellText("Pierre"), background: 'linear-gradient(#b8b5ad, #b8b5ad)' },
    { id: 'solid-gray', label: shellText("Gris"), background: 'linear-gradient(#727777, #727777)' },
    { id: 'solid-blue', label: shellText("Bleu"), background: 'linear-gradient(#7d9fb4, #7d9fb4)' },
    { id: 'solid-green', label: shellText("Vert"), background: 'linear-gradient(#8d9e88, #8d9e88)' },
    { id: 'solid-yellow', label: shellText("Jaune"), background: 'linear-gradient(#e7c578, #e7c578)' },
    { id: 'solid-orange', label: shellText("Orange"), background: 'linear-gradient(#d99c76, #d99c76)' },
    { id: 'solid-red', label: shellText("Rouge"), background: 'linear-gradient(#c57f78, #c57f78)' },
    { id: 'solid-pink', label: shellText("Rose poudré"), background: 'linear-gradient(#cba3ae, #cba3ae)' },
  ] },
  { label: shellText("Textures · Poly Haven"), items: [
    { id: "texture-blue-plaster-wall", label: shellText("Enduit bleu"), background: `url("${extraCover0}")` },
    { id: "texture-blue-metal-plate", label: shellText("Métal bleu"), background: `url("${extraCover1}")` },
    { id: "texture-green-metal-rust", label: shellText("Métal patiné"), background: `url("${extraCover2}")` },
    { id: "texture-grey-plaster", label: shellText("Enduit gris"), background: `url("${extraCover3}")` },
    { id: "texture-denim-fabric", label: shellText("Denim"), background: `url("${extraCover4}")` },
    { id: "texture-marble-01", label: shellText("Marbre"), background: `url("${extraCover5}")` },
    { id: "texture-clay-plaster", label: shellText("Argile"), background: `url("${extraCover6}")` },
    { id: "texture-rusty-painted-metal", label: shellText("Métal rouillé"), background: `url("${extraCover7}")` },
    { id: "texture-concrete", label: shellText("Béton"), background: `url("${extraCover8}")` },
    { id: "texture-red-plaster-weathered", label: shellText("Enduit rouge"), background: `url("${extraCover9}")` },
    { id: "texture-yellow-plaster", label: shellText("Enduit jaune"), background: `url("${extraCover10}")` },
  ] },
  { label: shellText("Peintures · The Met"), items: [
    { id: "met-436965", label: shellText("La famille Monet au jardin · Edouard Manet"), background: `url("${extraCover11}")` },
    { id: "met-436105", label: shellText("La Mort de Socrate · Jacques Louis David"), background: `url("${extraCover12}")` },
    { id: "met-436121", label: shellText("Femme au vase de fleurs · Edgar Degas"), background: `url("${extraCover13}")` },
    { id: "met-437853", label: shellText("Venise · Joseph Mallord William Turner"), background: `url("${extraCover14}")` },
    { id: "met-437980", label: shellText("Cyprès · Vincent van Gogh"), background: `url("${extraCover15}")` },
    { id: "met-436524", label: shellText("Tournesols · Vincent van Gogh"), background: `url("${extraCover16}")` },
    { id: "met-437881", label: shellText("La Femme à l’aiguière · Johannes Vermeer"), background: `url("${extraCover17}")` },
    { id: "met-436529", label: shellText("L’Arlésienne · Vincent van Gogh"), background: `url("${extraCover18}")` },
    { id: "met-436532", label: shellText("Autoportrait au chapeau de paille · Vincent van Gogh"), background: `url("${extraCover19}")` },
  ] },
  { label: shellText("Bois et tissus · Poly Haven"), items: [
    { id: "texture-dark-wood", label: shellText("Bois sombre"), background: `url("${expansionCover0}")` },
    { id: "texture-plywood", label: shellText("Contreplaqué"), background: `url("${expansionCover1}")` },
    { id: "texture-rosewood-veneer1", label: shellText("Palissandre"), background: `url("${expansionCover2}")` },
    { id: "texture-wood-table", label: shellText("Bois de table"), background: `url("${expansionCover3}")` },
    { id: "texture-brown-leather", label: shellText("Cuir brun"), background: `url("${expansionCover4}")` },
    { id: "texture-fabric-pattern-05", label: shellText("Tissu à motifs"), background: `url("${expansionCover5}")` },
    { id: "texture-fabric-pattern-07", label: shellText("Étoffe tissée"), background: `url("${expansionCover6}")` },
    { id: "texture-quatrefoil-jacquard-fabric", label: shellText("Jacquard"), background: `url("${expansionCover7}")` },
  ] },
  { label: shellText("Sable et pierre · Poly Haven"), items: [
    { id: "texture-aerial-sand", label: shellText("Sable vu du ciel"), background: `url("${expansionCover8}")` },
    { id: "texture-coast-sand-01", label: shellText("Sable côtier"), background: `url("${expansionCover9}")` },
    { id: "texture-damp-beach-sand", label: shellText("Sable de plage"), background: `url("${expansionCover10}")` },
    { id: "texture-dense-sand", label: shellText("Sable dense"), background: `url("${expansionCover11}")` },
    { id: "texture-dark-rock", label: shellText("Roche sombre"), background: `url("${expansionCover12}")` },
    { id: "texture-coral-gravel", label: shellText("Gravier corallien"), background: `url("${expansionCover13}")` },
    { id: "texture-cobblestone-color", label: shellText("Pavés colorés"), background: `url("${expansionCover14}")` },
    { id: "texture-moss-wood", label: shellText("Bois et mousse"), background: `url("${expansionCover15}")` },
  ] },
  { label: shellText("Matières · Poly Haven"), items: [
    { id: "texture-white-plaster-02", label: shellText("Enduit blanc"), background: `url("${expansionCover16}")` },
    { id: "texture-blue-plaster-weathered", label: shellText("Enduit bleu patiné"), background: `url("${expansionCover17}")` },
    { id: "texture-painted-plaster-wall", label: shellText("Mur peint"), background: `url("${expansionCover18}")` },
    { id: "texture-rusty-metal", label: shellText("Métal rouillé"), background: `url("${expansionCover19}")` },
    { id: "texture-metal-plate", label: shellText("Plaque de métal"), background: `url("${expansionCover20}")` },
    { id: "texture-rough-concrete", label: shellText("Béton brut"), background: `url("${expansionCover21}")` },
    { id: "texture-plastered-wall", label: shellText("Mur enduit"), background: `url("${expansionCover22}")` },
    { id: "texture-red-brick-plaster-patch-02", label: shellText("Briques et enduit"), background: `url("${expansionCover23}")` },
  ] },
  { label: shellText("Paysages · Cleveland Museum of Art"), items: [
    { id: "cma-152006", label: shellText("Rocky, Wooded Landscape with a Dell and Weir"), background: `url("${expansionCover24}")` },
    { id: "cma-151298", label: shellText("Prater Landscape"), background: `url("${expansionCover25}")` },
    { id: "cma-171296", label: shellText("Vale of Kashmir"), background: `url("${expansionCover26}")` },
    { id: "cma-139454", label: shellText("Landscape"), background: `url("${expansionCover27}")` },
    { id: "cma-148739", label: shellText("Landscape with Large Trees"), background: `url("${expansionCover28}")` },
    { id: "cma-79932", label: shellText("Landscape with Fishermen"), background: `url("${expansionCover29}")` },
    { id: "cma-125873", label: shellText("Shepherds in a Landscape"), background: `url("${expansionCover30}")` },
    { id: "cma-143234", label: shellText("Landscape with a Windmill"), background: `url("${expansionCover31}")` },
    { id: "cma-143602", label: shellText("Low Waterfall in a Wooded Landscape with a Dead Beech Tree"), background: `url("${expansionCover32}")` },
    { id: "cma-83635", label: shellText("Breton Landscape"), background: `url("${expansionCover33}")` },
    { id: "cma-159501", label: shellText("Landscape with Peasants Dancing"), background: `url("${expansionCover34}")` },
    { id: "cma-149417", label: shellText("Landscape with Gentle Peaks"), background: `url("${expansionCover35}")` },
    { id: "cma-112586", label: shellText("Venus Reclining in a Landscape"), background: `url("${expansionCover36}")` },
    { id: "cma-141639", label: shellText("Twilight in the Wilderness"), background: `url("${expansionCover37}")` },
    { id: "cma-159769", label: shellText("Italian Landscape"), background: `url("${expansionCover38}")` },
    { id: "cma-150176", label: shellText("Classical Landscape"), background: `url("${expansionCover39}")` },
  ] },
  { label: shellText("Fleurs et oiseaux · Cleveland Museum of Art"), items: [
    { id: "cma-130391", label: shellText("Spring Flowers"), background: `url("${additionalCover0}")` },
    { id: "cma-136207", label: shellText("Flowers in a Glass"), background: `url("${additionalCover1}")` },
    { id: "cma-115067", label: shellText("Vase of Flowers"), background: `url("${additionalCover2}")` },
    { id: "cma-143462", label: shellText("Ink Flowers"), background: `url("${additionalCover3}")` },
    { id: "cma-153736", label: shellText("Winter and Summer Flowers"), background: `url("${additionalCover4}")` },
    { id: "cma-135469", label: shellText("Vase of Flowers"), background: `url("${additionalCover5}")` },
    { id: "cma-153737", label: shellText("Winter and Summer Flowers"), background: `url("${additionalCover6}")` },
    { id: "cma-153735", label: shellText("Winter and Summer Flowers"), background: `url("${additionalCover7}")` },
    { id: "cma-125886", label: shellText("Birds and Flowers"), background: `url("${additionalCover8}")` },
    { id: "cma-125884", label: shellText("Birds and Flowers"), background: `url("${additionalCover9}")` },
  ] },
  { label: shellText("Mers et rivages · Cleveland Museum of Art"), items: [
    { id: "cma-92480", label: shellText("Seascape with Open Sky"), background: `url("${additionalCover10}")` },
    { id: "cma-143272", label: shellText("Seascape"), background: `url("${additionalCover11}")` },
    { id: "cma-101951", label: shellText("Seascape"), background: `url("${additionalCover12}")` },
    { id: "cma-83453", label: shellText("The Beach at Saint-Jacut"), background: `url("${additionalCover13}")` },
    { id: "cma-130974", label: shellText("The Rocky Seashore"), background: `url("${additionalCover14}")` },
    { id: "cma-134862", label: shellText("Marine"), background: `url("${additionalCover15}")` },
    { id: "cma-157428", label: shellText("Edwin Booth's Boat House, Near Newport, August 6, 1884"), background: `url("${additionalCover16}")` },
    { id: "cma-97315", label: shellText("Abalone Divers off the Coast of Ise, from an Untitled Landscape Series"), background: `url("${additionalCover17}")` },
    { id: "cma-142659", label: shellText("The Cliffs at Beg-ar-Fry, Saint-Jean-du-Doigt"), background: `url("${additionalCover18}")` },
    { id: "cma-119697", label: shellText("Boats at Berck-sur-Mer"), background: `url("${additionalCover19}")` },
  ] },
  { label: shellText("Montagnes · Cleveland Museum of Art"), items: [
    { id: "cma-113945", label: shellText("Cloudy Mountains"), background: `url("${additionalCover20}")` },
    { id: "cma-130361", label: shellText("Streams and Mountains without End"), background: `url("${additionalCover21}")` },
    { id: "cma-149791", label: shellText("Mt. Qingbian"), background: `url("${additionalCover22}")` },
    { id: "cma-145010", label: shellText("Shakyamuni Emerging from the Mountains"), background: `url("${additionalCover23}")` },
    { id: "cma-160138", label: shellText("Streams and Mountains"), background: `url("${additionalCover24}")` },
    { id: "cma-143477", label: shellText("An October Day in the White Mountains"), background: `url("${additionalCover25}")` },
    { id: "cma-135836", label: shellText("Buddhist Retreat by Stream and Mountains"), background: `url("${additionalCover26}")` },
    { id: "cma-160137", label: shellText("Mountains of the Immortals"), background: `url("${additionalCover27}")` },
    { id: "cma-136296", label: shellText("Dream Journey among Rivers and Mountains, no. 90"), background: `url("${additionalCover28}")` },
    { id: "cma-144732", label: shellText("Storm in the Mountains"), background: `url("${additionalCover29}")` },
  ] },
  { label: shellText("Paysages japonais · Cleveland Museum of Art"), items: [
    { id: "cma-159739", label: shellText("Snow Landscape"), background: `url("${additionalCover30}")` },
    { id: "cma-150165", label: shellText("Landscape"), background: `url("${additionalCover31}")` },
    { id: "cma-148810", label: shellText("Haboku (Flung-ink) Landscape"), background: `url("${additionalCover32}")` },
  ] },
  { label: shellText("Images spatiales"), items: [
    { id: 'earth', label: shellText("La Terre"), background: `url("${earth}")` },
    { id: 'desert', label: shellText("Désert australien"), background: `url("${desert}")` },
    { id: 'nebula', label: shellText("Nébuleuse"), background: `url("${nebula}")` },
  ] },
  { label: shellText("Paysages · The Met"), items: [
    { id: 'met-oxbow', label: shellText("The Oxbow · Thomas Cole"), background: `url("${oxbow}")` },
    { id: 'met-lake-george', label: shellText("Lake George · John Frederick Kensett"), background: `url("${lakeGeorge}")` },
    { id: 'met-rocky-mountains', label: shellText("Rocky Mountains · Albert Bierstadt"), background: `url("${rockyMountains}")` },
    { id: 'met-aegean-sea', label: shellText("The Aegean Sea · Frederic Edwin Church"), background: `url("${aegeanSea}")` },
    { id: 'met-wheat-field-cypresses', label: shellText("Champ de blé aux cyprès · Vincent van Gogh"), background: `url("${cypresses}")` },
    { id: 'met-summer-afternoon', label: shellText("Après-midi d’été · Asher Brown Durand"), background: `url("${summerAfternoon}")` },
    { id: 'met-gulf-stream', label: shellText("Le Gulf Stream · Winslow Homer"), background: `url("${gulfStream}")` },
  ] },
  { label: shellText("Vagues · The Met"), items: [
    { id: 'met-great-wave', label: shellText("La Grande Vague · Hokusai"), background: `url("${greatWave}")` },
    { id: 'met-sete-wave', label: shellText("La Grande Vague, Sète · Gustave Le Gray"), background: `url("${seteWave}")` },
  ] },
  { label: shellText("Fleurs · The Met"), items: [
    { id: 'met-irises', label: shellText("Iris · Vincent van Gogh"), background: `url("${irises}")` },
    { id: 'met-roses', label: shellText("Roses · Vincent van Gogh"), background: `url("${roses}")` },
  ] },
  { label: shellText("Estampes japonaises · The Met"), items: [
    { id: 'met-hara-fuji', label: shellText("Le mont Fuji au matin · Utagawa Hiroshige"), background: `url("${haraFuji}")` },
    { id: 'met-nihonbashi', label: shellText("Averse à Nihonbashi · Utagawa Hiroshige"), background: `url("${nihonbashi}")` },
    { id: 'met-fuji-senju', label: shellText("Fuji vu de Senju · Katsushika Hokusai"), background: `url("${fujiSenju}")` },
  ] },
] as const;

export const COVER_PRESETS = COVER_GROUPS.flatMap((group) => [...group.items]);
/** The database row header stores URLs, so encode our built-in gradients as image sources. */
export const COVER_GALLERY = COVER_GROUPS.map((group) => ({
  label: group.label,
  items: group.items.map((item) => {
    const image = /^url\("(.*)"\)$/.exec(item.background);
    if (image) return {label: item.label, url: image[1]};
    const colors = item.background.match(/#[a-f0-9]{6}/gi) ?? ['#777777'];
    const stops = colors.map((color, index) => `<stop offset="${index / Math.max(1, colors.length - 1) * 100}%" stop-color="${color}"/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600"><defs><linearGradient id="g">${stops}</linearGradient></defs><path fill="url(#g)" d="M0 0h1600v600H0z"/></svg>`;
    return {label: item.label, url: `data:image/svg+xml,${encodeURIComponent(svg)}`};
  }),
}));
export type CoverId = typeof COVER_PRESETS[number]['id'];
export type PageCover = CoverId | (string & {});
export function isPageCover(value: unknown): value is PageCover {
  if (isCoverId(value)) return true;
  if (typeof value !== 'string') return false;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return true;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}
export function readCoverFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) return Promise.reject(new Error('Choisissez une image PNG, JPEG, GIF ou WebP.'));
  if (file.size > 5 * 1024 * 1024) return Promise.reject(new Error('L’image doit peser moins de 5 Mo.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Impossible de lire cette image.'));
    reader.readAsDataURL(file);
  });
}
export interface CoverOptions {
  upload?: (dataUrl: string) => Promise<string>;
  resolveUrl?: (url: string) => Promise<string>;
  readOnly?: boolean;
}
export const isCoverId = (value: unknown): value is CoverId => COVER_PRESETS.some((item) => item.id === value);

/**
 * Paints the page header's hover state as an attribute instead of leaning on CSS
 * `:hover`.
 *
 * workspace.ts re-appends the add-cover button whenever the core rebuilds the icon
 * row. WebKit — the engine behind the packaged Tauri window — never delivers the
 * matching `mouseleave` for a node moved under the cursor, so `:hover` on the header
 * latched and the button never left. The core's add-icon button is never moved, so
 * only this one stuck. Delegation reads the pointer's live target, so a replaced node
 * changes nothing.
 */
export function trackPageHeaderHover(root: Document): () => void {
  const HEADER = '[data-blok-page-header]';
  const FLAG = 'data-desktop-header-hover';
  const clear = (): void => {
    for (const header of root.querySelectorAll(HEADER)) header.removeAttribute(FLAG);
  };
  const over = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest(HEADER) : null;
    clear();
    target?.setAttribute(FLAG, '');
  };
  const out = (event: Event): void => {
    const to = event instanceof MouseEvent && event.relatedTarget instanceof Element ? event.relatedTarget : null;
    if (to?.closest(HEADER)) return;
    clear();
  };
  root.addEventListener('pointerover', over, true);
  root.addEventListener('pointerout', out, true);
  return () => {
    root.removeEventListener('pointerover', over, true);
    root.removeEventListener('pointerout', out, true);
    clear();
  };
}

export function createAddCoverButton(onChange: (cover: CoverId) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('data-desktop-add-cover', '');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 4.5h14v11H3zM3 13l4.2-4 3.2 3 2.5-2.2L17 13.5M13.5 7.2h.01');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  button.append(svg, document.createTextNode(shellText("Ajouter une couverture")));
  button.addEventListener('click', () => onChange('dusk'));
  return button;
}

export function createPageCover(
  value: PageCover,
  position: number,
  onChange: (cover: PageCover | undefined) => void,
  onPositionChange: (position: number) => void,
  options: CoverOptions = {},
): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-desktop-cover', '');
  const image = document.createElement('div');
  image.setAttribute('data-desktop-cover-image', '');
  image.setAttribute('role', 'img');
  image.setAttribute('aria-label', shellText("Couverture de la page"));
  const preset = COVER_PRESETS.find((item) => item.id === value);
  image.style.backgroundImage = preset?.background ?? `url(${JSON.stringify(value)})`;
  if (!preset && options.resolveUrl) void options.resolveUrl(value).then((url) => {
    image.style.backgroundImage = `url(${JSON.stringify(url)})`;
  }).catch(() => undefined);
  const applyPosition = (next: number): void => { image.style.backgroundPosition = `center ${next}%`; };
  applyPosition(position);

  const actions = document.createElement('div');
  actions.setAttribute('data-desktop-cover-actions', '');
  const reposition = document.createElement('button');
  reposition.type = 'button';
  reposition.textContent = shellText("Repositionner");
  const change = document.createElement('button');
  change.type = 'button';
  change.textContent = shellText("Changer la couverture");
  change.setAttribute('aria-haspopup', 'dialog');
  change.setAttribute('aria-expanded', 'false');
  const download = createCoverDownloadButton(async () => {
    const index = COVER_PRESETS.findIndex((item) => item.id === value);
    const builtin = index < 0 ? undefined : COVER_GALLERY.flatMap((group) => group.items)[index];
    const url = builtin?.url ?? (options.resolveUrl ? await options.resolveUrl(value) : value);
    return {url, ...(builtin ? {name: `${value}.${url.startsWith('data:image/svg+xml') ? 'svg' : 'jpg'}`} : {})};
  }, 'Télécharger la couverture', 'Téléchargement impossible. Vérifiez la connexion ou les autorisations de l’image.');

  const gallery = document.createElement('div');
  gallery.setAttribute('data-desktop-cover-gallery', '');
  gallery.setAttribute('role', 'dialog');
  gallery.setAttribute('aria-label', shellText("Choisir une couverture"));
  gallery.hidden = true;
  gallery.id = 'cover-picker-' + crypto.randomUUID();
  change.setAttribute('aria-controls', gallery.id);
  let selectionVersion = 0;
  const choose = (next: PageCover | undefined): void => {
    selectionVersion++;
    const parent = root.parentElement;
    const restoreFocus = actions.contains(document.activeElement);
    closeGallery();
    onChange(next);
    if (restoreFocus) {
      const trigger = root.isConnected ? change : parent?.querySelector<HTMLElement>(
        next === undefined ? '[data-blok-page-title]' : '[data-desktop-cover-actions] > [aria-haspopup="dialog"]',
      ) ?? parent?.querySelector<HTMLElement>('[data-desktop-add-cover]');
      trigger?.focus({preventScroll:true});
    }
  };
  const head = document.createElement('div');
  head.setAttribute('data-desktop-cover-gallery-head', '');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = shellText("Supprimer");
  remove.addEventListener('click', () => choose(undefined));
  const removeFromPage = document.createElement('button');
  removeFromPage.type = 'button';
  removeFromPage.textContent = shellText("Retirer");
  removeFromPage.setAttribute('aria-label', shellText("Retirer la couverture"));
  removeFromPage.title = shellText("Retirer la couverture");
  removeFromPage.addEventListener('click', () => choose(undefined));
  gallery.append(head);
  const tabs = document.createElement('div');
  tabs.setAttribute('data-desktop-cover-tabs', '');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', shellText("Source de la couverture"));
  head.append(tabs, remove);
  const scroll = document.createElement('div');
  scroll.setAttribute('data-desktop-cover-gallery-scroll', '');
  const scrollFrame = document.createElement('div');
  scrollFrame.setAttribute('data-desktop-cover-gallery-viewport', '');
  const scrollbar = document.createElement('div');
  scrollbar.setAttribute('data-desktop-cover-gallery-scrollbar', '');
  scrollbar.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('div');
  thumb.setAttribute('data-desktop-cover-gallery-thumb', '');
  scrollbar.append(thumb);
  for (const group of COVER_GROUPS) {
    const section = document.createElement('section');
    section.setAttribute('aria-label', group.label);
    const heading = document.createElement('h3');
    heading.textContent = group.label;
    const grid = document.createElement('div');
    grid.setAttribute('data-desktop-cover-grid', '');
    for (const preset of group.items) {
      const option = document.createElement('button');
      option.type = 'button';
      option.setAttribute('aria-label', preset.label);
      option.setAttribute('title', preset.label);
      option.setAttribute('data-cover-id', preset.id);
      option.setAttribute('aria-pressed', String(preset.id === value));
      option.style.backgroundImage = preset.background;
      option.addEventListener('click', () => choose(preset.id));
      grid.append(option);
    }
    const buttons = [...grid.querySelectorAll('button')];
    const current = buttons.find(button => button.getAttribute('aria-pressed') === 'true') ?? buttons[0];
    buttons.forEach(button => { button.tabIndex = button === current ? 0 : -1; });
    grid.addEventListener('keydown', event => {
      const at = buttons.indexOf(event.target as HTMLButtonElement);
      if (at < 0) return;
      const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
      let next: number;
      switch (event.key) {
        case 'ArrowRight': next = at + 1; break;
        case 'ArrowLeft': next = at - 1; break;
        case 'ArrowDown': next = at + columns; break;
        case 'ArrowUp': next = at - columns; break;
        case 'Home': next = 0; break;
        case 'End': next = buttons.length - 1; break;
        default: return;
      }
      event.preventDefault();
      buttons[Math.max(0, Math.min(next, buttons.length - 1))].focus();
    });
    grid.addEventListener('focusin', event => {
      buttons.forEach(button => { button.tabIndex = button === event.target ? 0 : -1; });
    });
    section.append(heading, grid);
    scroll.append(section);
  }
  scrollFrame.append(scroll, scrollbar);
  gallery.append(scrollFrame);
  const uploadPanel = document.createElement('div');
  uploadPanel.setAttribute('data-desktop-cover-panel', '');
  const upload = document.createElement('button');
  upload.type = 'button';
  upload.textContent = shellText("Choisir une image");
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/gif,image/webp';
  file.hidden = true;
  const hint = document.createElement('p');
  hint.textContent = shellText("PNG, JPEG, GIF ou WebP · 5 Mo maximum");
  const uploadStatus = document.createElement('p');
  uploadStatus.setAttribute('role', 'status');
  upload.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    if (!selected) return;
    const version = selectionVersion;
    upload.disabled = true;
    uploadStatus.textContent = shellText("Importation…");
    void readCoverFile(selected).then((data) => options.upload ? options.upload(data) : data).then((url) => {
      if (version !== selectionVersion) return;
      if (!isPageCover(url)) throw new Error('Image invalide.');
      choose(url);
    }).catch((error: unknown) => {
      uploadStatus.textContent = error instanceof Error ? error.message : shellText("Impossible d’importer cette image.");
    }).finally(() => { upload.disabled = false; file.value = ''; });
  });
  uploadPanel.append(upload, file, hint, uploadStatus);
  const linkPanel = document.createElement('form');
  linkPanel.setAttribute('data-desktop-cover-panel', '');
  linkPanel.noValidate = true;
  const link = document.createElement('input');
  link.type = 'url';
  link.placeholder = 'https://exemple.com/image.jpg';
  link.setAttribute('aria-label', shellText("Lien de l’image de couverture"));
  link.required = true;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = shellText("Appliquer");
  const linkStatus = document.createElement('p');
  linkStatus.setAttribute('role', 'status');
  const linkHint = document.createElement('p');
  linkHint.textContent = shellText("Collez le lien direct d’une image.");
  linkPanel.append(link, submit, linkHint, linkStatus);
  linkPanel.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = link.value.trim();
    if (!/^https?:\/\//i.test(url) || !isPageCover(url)) { linkStatus.textContent = shellText("Saisissez une adresse HTTP ou HTTPS valide."); return; }
    choose(new URL(url).href);
  });
  const content = document.createElement('div');
  content.setAttribute('data-desktop-cover-content', '');
  const linkTabPanel = document.createElement('div');
  linkTabPanel.append(linkPanel);
  content.append(scrollFrame, uploadPanel, linkTabPanel);
  gallery.append(content);
  const panels = [scrollFrame, uploadPanel, linkTabPanel];
  const tabButtons: HTMLButtonElement[] = [];
  const selectTab = (index: number): void => {
    content.toggleAttribute('data-gallery', index === 0);
    panels.forEach((panel, current) => { panel.hidden = current !== index; });
    tabButtons.forEach((tab, current) => { tab.setAttribute('aria-selected', String(current === index)); tab.tabIndex = current === index ? 0 : -1; });
    updateScrollbar();
  };
  ['Galerie', 'Importer', 'Lien'].forEach((label, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.textContent = label;
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      selectTab(next); tabButtons[next].focus();
    });
    tabButtons.push(tab); tabs.append(tab);
    panels[index].setAttribute('role', 'tabpanel');
    tab.id = gallery.id + '-tab-' + index;
    tab.setAttribute('aria-controls', gallery.id + '-panel-' + index);
    panels[index].id = gallery.id + '-panel-' + index;
    panels[index].setAttribute('aria-labelledby', tab.id);
  });
  const updateScrollbar = (): void => {
    const maxScroll = scroll.scrollHeight - scroll.clientHeight;
    scrollbar.hidden = maxScroll <= 1;
    if (scrollbar.hidden) return;
    const trackHeight = scrollbar.clientHeight;
    const thumbHeight = Math.max(24, trackHeight * scroll.clientHeight / scroll.scrollHeight);
    const travel = Math.max(0, trackHeight - thumbHeight);
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${travel * scroll.scrollTop / maxScroll}px)`;
  };
  selectTab(0);
  scroll.addEventListener('scroll', updateScrollbar);
  let dragStart: { y: number; scrollTop: number } | null = null;
  thumb.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragStart = { y: event.clientY, scrollTop: scroll.scrollTop };
    thumb.setPointerCapture(event.pointerId);
  });
  thumb.addEventListener('pointermove', (event) => {
    if (!dragStart) return;
    const travel = scrollbar.clientHeight - thumb.clientHeight;
    if (travel > 0) scroll.scrollTop = dragStart.scrollTop
      + (event.clientY - dragStart.y) * (scroll.scrollHeight - scroll.clientHeight) / travel;
  });
  const endDrag = (): void => { dragStart = null; };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);
  scrollbar.addEventListener('pointerdown', (event) => {
    if (event.target === thumb) return;
    const travel = scrollbar.clientHeight - thumb.clientHeight;
    if (travel <= 0) return;
    const y = event.clientY - scrollbar.getBoundingClientRect().top - thumb.clientHeight / 2;
    scroll.scrollTop = y * (scroll.scrollHeight - scroll.clientHeight) / travel;
  });
  let unregisterGallery: (() => void) | undefined;
  const layoutGallery = (): void => {
    const bounds = root.getBoundingClientRect();
    if (bounds.width > 0) gallery.style.maxWidth = Math.max(0, bounds.width - 24) + 'px';
    const top = gallery.getBoundingClientRect().top;
    content.style.setProperty('--desktop-cover-gallery-height', Math.max(0, Math.min(350, window.innerHeight - top - head.offsetHeight - 12)) + 'px');
    updateScrollbar();
  };
  const closeGallery = (restoreFocus = false): void => {
    unregisterGallery?.();
    unregisterGallery = undefined;
    gallery.hidden = true;
    change.setAttribute('aria-expanded', 'false');
    actions.removeAttribute('data-open');
    if (restoreFocus) change.focus({preventScroll:true});
  };
  change.addEventListener('click', () => {
    if (gallery.hidden) {
      gallery.hidden = false;
      layoutGallery();
      const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(layoutGallery);
      resize?.observe(root);
      const release = registerLayer({element:gallery, anchor:change, onDismiss:reason => closeGallery(reason === 'escape')});
      unregisterGallery = () => { release(); resize?.disconnect(); };
      tabButtons.find(tab => tab.tabIndex === 0)?.focus({preventScroll:true});
      change.setAttribute('aria-expanded', 'true');
      actions.setAttribute('data-open', '');
    } else closeGallery();
  });
  actions.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && !actions.contains(event.relatedTarget)) closeGallery();
  });

  const drag = document.createElement('div');
  drag.setAttribute('data-desktop-cover-drag', '');
  drag.setAttribute('role', 'slider');
  drag.setAttribute('aria-label', shellText("Position verticale de la couverture"));
  drag.setAttribute('aria-valuemin', '0');
  drag.setAttribute('aria-valuemax', '100');
  drag.tabIndex = 0;
  drag.hidden = true;
  const guide = document.createElement('span');
  guide.textContent = shellText("Glisser pour repositionner la couverture");
  drag.append(guide);
  let savedPosition = position;
  let draft = position;
  let unregisterReposition: (() => void) | null = null;
  let start: { y: number; position: number } | null = null;
  const setDraft = (next: number): void => {
    draft = Math.max(0, Math.min(100, Math.round(next)));
    drag.setAttribute('aria-valuenow', String(draft));
    applyPosition(draft);
  };
  setDraft(position);
  const finish = (restoreFocus = true): void => {
    unregisterReposition?.();
    unregisterReposition = null;
    start = null;
    drag.hidden = true;
    root.removeAttribute('data-repositioning');
    actions.replaceChildren(change, reposition, download, removeFromPage, gallery);
    actions.removeAttribute('data-open');
    if (restoreFocus) reposition.focus();
  };
  const commitPosition = (restoreFocus = true): void => {
    const changed = draft !== savedPosition;
    savedPosition = draft;
    finish(restoreFocus);
    if (changed) onPositionChange(savedPosition);
  };
  const cancelPosition = (): void => { setDraft(savedPosition); finish(); };
  drag.addEventListener('pointerdown', (event) => {
    start = { y: event.clientY, position: draft };
    drag.setPointerCapture(event.pointerId);
  });
  drag.addEventListener('pointermove', (event) => {
    if (start) setDraft(start.position - (event.clientY - start.y) / 2);
  });
  drag.addEventListener('pointerup', () => { start = null; });
  drag.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') setDraft(draft + 5);
    else if (event.key === 'ArrowDown') setDraft(draft - 5);
    else if (event.key === 'Home') setDraft(0);
    else if (event.key === 'End') setDraft(100);
    else if (event.key === 'Escape') cancelPosition();
    else return;
    event.preventDefault();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = shellText("Annuler");
  cancel.addEventListener('click', cancelPosition);
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = shellText("Enregistrer la position");
  save.addEventListener('click', () => commitPosition());
  reposition.addEventListener('click', () => {
    closeGallery();
    drag.hidden = false;
    root.setAttribute('data-repositioning', '');
    actions.replaceChildren(cancel, save);
    actions.setAttribute('data-open', '');
    drag.focus();
    unregisterReposition?.();
    unregisterReposition = registerLayer({
      element: root,
      onDismiss: (reason) => { if (reason === 'outside') commitPosition(false); else cancelPosition(); },
    });
  });
  actions.append(change, reposition, download, removeFromPage, gallery);
  root.append(image, drag);
  if (!options.readOnly) root.append(actions);
  return root;
}
