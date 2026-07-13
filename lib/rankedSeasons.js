const YEAR_SEASON_TO_NUM = /** @type {Record<string,number>} */ ({
  Y1S1:1,  Y1S2:2,  Y1S3:3,  Y1S4:4,
  Y2S1:5,  Y2S2:6,  Y2S3:7,  Y2S4:8,
  Y3S1:9,  Y3S2:10, Y3S3:11, Y3S4:12,
  Y4S1:13, Y4S2:14, Y4S3:15, Y4S4:16,
  Y5S1:17, Y5S2:18, Y5S3:19, Y5S4:20,
  Y6S1:21, Y6S2:22, Y6S3:23, Y6S4:24,
  Y7S1:25, Y7S2:26, Y7S3:27, Y7S4:28,
  Y8S1:29, Y8S2:30, Y8S3:31, Y8S4:32,
  Y9S1:33, Y9S2:34, Y9S3:35, Y9S4:36,
  Y10S1:37,Y10S2:38,Y10S3:39,Y10S4:40,
  Y11S1:41,Y11S2:42,Y11S3:43,Y11S4:44,
});

const SEASON_CHAMPION = 15;   // Y4S3 Operation Ember Rise — Champion introduced
const SEASON_EMERALD  = 28;   // Y7S4 Operation Solar Raid — Emerald introduced

const SEASON_NAMES = {
  1:'Black Ice',2:'Dust Line',3:'Skull Rain',4:'Red Crow',
  5:'Velvet Shell',6:'Health',7:'Blood Orchid',8:'White Noise',
  9:'Chimera',10:'Para Bellum',11:'Grim Sky',12:'Wind Bastion',
  13:'Burnt Horizon',14:'Phantom Sight',15:'Ember Rise',16:'Shifting Tides',
  17:'Void Edge',18:'Steel Wave',19:'Shadow Legacy',20:'Neon Dawn',
  21:'Crimson Heist',22:'North Star',23:'Crystal Guard',24:'High Calibre',
  25:'Demon Veil',26:'Vector Glare',27:'Brutal Swarm',28:'Solar Raid',
  29:'Commanding Force',30:'Dread Factor',31:'Heavy Mettle',32:'Deep Freeze',
  // Y9
  33:'Deadly Omen',34:'New Blood',35:'Twin Shells',36:'Collision Point',
  // Y10
  37:'Prep Phase',38:'Daybreak',39:'High Stakes',40:'Tenfold Pursuit',
  // Y11
  41:'Silent Hunt',42:'System Override',
};

module.exports = {
  YEAR_SEASON_TO_NUM,
  SEASON_CHAMPION,
  SEASON_EMERALD,
  SEASON_NAMES,
};
