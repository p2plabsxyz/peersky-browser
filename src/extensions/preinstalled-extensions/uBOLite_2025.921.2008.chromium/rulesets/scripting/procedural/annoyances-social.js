/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

// ruleset: annoyances-social

// Important!
// Isolate from global scope
(function uBOL_cssProceduralImport() {

/******************************************************************************/

const argsList = ["[]","[{\"selector\":\".Button_root__UZ8td\",\"tasks\":[[\"has-text\",\"Share\"]]}]","[{\"selector\":\".article_detail__top_stories\",\"tasks\":[[\"has-text\",\"Follow us for ev updates\"]]}]","[{\"selector\":\".block-single-post__aside-heading\",\"tasks\":[[\"has-text\",\"Share\"]]}]","[{\"selector\":\".border-y.py-2\",\"tasks\":[[\"has-text\",\"Share\"]]}]","[{\"selector\":\".col-xs-12 > div\",\"tasks\":[[\"has-text\",\"Follow AppleInsider\"]]}]","[{\"selector\":\".dcr-4gwv1z > ul\",\"tasks\":[[\"has-text\",\"Get our\"]]}]","[{\"selector\":\".edproj-share-video-wrapper\",\"tasks\":[[\"has-text\",\"Share your video\"]]},{\"selector\":\".edproj-speedhub-wrapper\",\"tasks\":[[\"has-text\",\"read now\"]]},{\"selector\":\".free-body.text-block > p.content-item\",\"tasks\":[[\"has-text\",\"Email\"]]}]","[{\"selector\":\".elementor-button-wrapper\",\"tasks\":[[\"has-text\",\"Social Media\"]]}]","[{\"selector\":\".elementor-heading-title\",\"tasks\":[[\"has-text\",\"SHARE\"]]}]","[{\"selector\":\".elementor-widget-container > h2\",\"tasks\":[[\"has-text\",\"Please share\"]]}]","[{\"selector\":\".execphpwidget\",\"tasks\":[[\"has-text\",\"FREE UPDATES!\"]]}]","[{\"selector\":\".heading-title\",\"tasks\":[[\"has-text\",\"Follow US\"]]}]","[{\"selector\":\".justify-between.items-center\",\"tasks\":[[\"has-text\",\"Share:\"]]}]","[{\"selector\":\".mar-b-6\",\"tasks\":[[\"has-text\",\"Follow Us\"]]}]","[{\"selector\":\".padding-top-small > .widgetizedArea\",\"tasks\":[[\"has-text\",\"Like this\"]]}]","[{\"selector\":\".po-fr__heading\",\"tasks\":[[\"has-text\",\"Share this article\"]]}]","[{\"selector\":\".post_style_zk > p\",\"tasks\":[[\"has-text\",\"Please subscribe\"]]}]","[{\"selector\":\".promo-card-muted\",\"tasks\":[[\"has-text\",\"RSS feed\"]]}]","[{\"selector\":\".py-4\",\"tasks\":[[\"has-text\",\"Share This Article\"]]}]","[{\"selector\":\".tdm-descr\",\"tasks\":[[\"has-text\",\"Share\"]]}]","[{\"selector\":\".tds-button\",\"tasks\":[[\"has-text\",\"FOLLOW ON GOOGLE NEWS\"]]}]","[{\"selector\":\".tw-balloon\",\"tasks\":[[\"has-text\",\"Share To\"]]}]","[{\"selector\":\".widget-title\",\"tasks\":[[\"has-text\",\"Share this page!\"]]}]","[{\"selector\":\".widget_custom_html\",\"tasks\":[[\"has-text\",\"Follow us\"]]}]","[{\"selector\":\"[data-ga-track-action]\",\"tasks\":[[\"has-text\",\"Join The Conversation\"]]}]","[{\"selector\":\"[style=\\\"position: sticky; top: 55px;\\\"]\",\"tasks\":[[\"has-text\",\"Inscrivez-vous à notre newsletter quotidienne !\"]]}]","[{\"selector\":\"p.cms-textAlign-center\",\"tasks\":[[\"has-text\",\"follow NBC Sports\"]]}]","[{\"selector\":\"strong\",\"tasks\":[[\"has-text\",\"/Stay informed|Stay on top/\"]]}]","[{\"selector\":\".tve_social_items\",\"action\":[\"style\",\"visibility:hidden !important\"],\"cssable\":true}]","[{\"selector\":\"body, html\",\"action\":[\"style\",\"height: auto !important; overflow: auto !important\"],\"cssable\":true}]","[{\"selector\":\"body\",\"action\":[\"style\",\"overflow: auto !important;\"],\"cssable\":true}]","[{\"selector\":\"body\",\"action\":[\"style\",\"overflow: auto !important; position: initial !important;\"],\"cssable\":true}]","[{\"selector\":\"html\",\"action\":[\"style\",\"overflow: auto !important; position: initial !important;\"],\"cssable\":true}]"];
const argsSeqs = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33];
const hostnamesMap = new Map([["abc.net.au",1],["carnewschina.com",2],["qodo.ai",3],["thedispatch.com",4],["appleinsider.com",5],["theguardian.com",6],["stuff.co.nz",7],["newskarnataka.com",8],["bitcoinsensus.com",9],["freethoughtnow.org",10],["openculture.com",11],["cryptotimes.io",12],["neon.tech",13],["techissuestoday.com",14],["theshovel.com.au",15],["jacobin.com",16],["lifenews.com",17],["newsroom.ucla.edu",18],["futurism.com",19],["tvblackbox.com.au",20],["heritagedaily.com",21],["twitch.tv",22],["ruwix.com",23],["archaeologymag.com",24],["theintercept.com",25],["clubic.com",26],["nbcsports.com",27],["psypost.org",28],["swingliteracy.com",29],["ultraslan.com",30],["govtrack.us",31],["gulte.com",31],["aliprice.com",31],["vgtimes.com",32],["finance.yahoo.com",33]]);
const hasEntities = false;

self.proceduralImports = self.proceduralImports || [];
self.proceduralImports.push({ argsList, argsSeqs, hostnamesMap, hasEntities });

/******************************************************************************/

})();

/******************************************************************************/
