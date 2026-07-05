// messages from main to worker
window.RUN = 1;
window.ABORT = 2;

// messages from worker to main
window.OUTPUT = 10;
window.PROGRESS = 11;
window.ERROR = 12;
window.DONE = 13;

var MapStatus = [];
MapStatus[401] = "Unauthorized";
MapStatus[402] = "Payment Required";
MapStatus[403] = "Forbidden";
MapStatus[404] = "Not Found";
MapStatus[405] = "Method Not Allowed";
MapStatus[406] = "Not Acceptable";
MapStatus[407] = "Proxy Authentication Required";
MapStatus[408] = "Request Timeout";
MapStatus[409] = "Conflict";
MapStatus[410] = "Gone";
MapStatus[411] = "Length Required";
MapStatus[412] = "Precondition Failed";
MapStatus[413] = "Payload Too Large";
MapStatus[414] = "URI Too Large";
MapStatus[415] = "Unsupported Media Type";
MapStatus[429] = "Too Many Requests";
MapStatus[431] = "Request Header Fields Too Large";
MapStatus[451] = "Unavailable For Legal Reasons";
MapStatus[500] = "Internal Server Error";
MapStatus[501] = "Not Implemented";
MapStatus[502] = "Bad Gateway";
MapStatus[503] = "Service Unavailable";
MapStatus[504] = "Gateway Timeout";

export function getXMLHttpRequest() {
  if( XMLHttpRequest )
    return new XMLHttpRequest();
  else
    return new ActiveXObject("Microsoft.XMLHTTP");
}
